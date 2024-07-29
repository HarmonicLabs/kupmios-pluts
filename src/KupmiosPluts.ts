import { Address, AddressStr, CanResolveToUTxO, CostModelPlutusV1Array, CostModelPlutusV2Array, CostModels, Data, ExBudget, GenesisInfos, Hash28, Hash32, NormalizedGenesisInfos, ProtocolParameters, Script, Tx, TxOutRef, UTxO, Value, dataFromCbor, defaultProtocolParameters, isITxOutRef, isIUTxO } from "@harmoniclabs/plu-ts";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { webcrypto } from "crypto";
import { WebSocket } from "ws";
import { rationalFromString } from "./utils/rationalFromString";

export interface KupmiosPlutsConfig {
    kupoUrl?: string | undefined;
    ogmiosUrl?: string | undefined
    kupoApiKey?: string | undefined
}

export class KupmiosPluts
{
    kupoUrl: string | undefined;
    ogmiosUrl: string | undefined;
    kupoApiKey: string | undefined;
    readonly ogmiosWs!: WebSocket;
    readonly isOgmiosWsReady: boolean

    close(): void
    {
        if( !this.isOgmiosWsReady ) return;
        
        this.ogmiosWs.close();
    }

    [Symbol.dispose]() { this.close(); }

    hasKupo(): boolean
    {
        return typeof this.kupoUrl === "string";
    }

    constructor({
        kupoUrl,
        kupoApiKey,
        ogmiosUrl
    }: KupmiosPlutsConfig)
    {
        this.kupoUrl = kupoUrl;
        this.kupoApiKey = kupoApiKey;
        this.ogmiosUrl = ogmiosUrl;
        
        let _ogmiosWs: WebSocket | undefined = undefined;
        let _isOgmiosReady = false;

        if( typeof this.ogmiosUrl === "string" )
        {
            Object.defineProperty(
                this, "ogmiosWs", {
                    get: () => {
                        if(!( _ogmiosWs instanceof WebSocket ))
                        {
                            _ogmiosWs = new WebSocket( this.ogmiosUrl as string );
                            _ogmiosWs.addEventListener("open", () => { _isOgmiosReady = true }, { once: true });
                            _isOgmiosReady = _isOgmiosReady || _ogmiosWs.readyState === WebSocket.OPEN;
                        }
                        return _ogmiosWs;
                    },
                    set: () => {},
                    enumerable: true,
                    configurable: false
                }
            );
            Object.defineProperty(
                this, "isOgmiosWsReady", {
                    get: () => {
                        if( _isOgmiosReady ) return true;
                        _isOgmiosReady = _ogmiosWs?.readyState === WebSocket.OPEN;
                        return _isOgmiosReady;
                    },
                    set: () => {},
                    enumerable: true,
                    configurable: false
                }
            );
        }
    }

    async submitTx( tx: Tx ): Promise<Hash32>
    {
        await this.ogmiosCall(
            "submitTransaction",
            { transaction: { cbor: tx.toCbor().toString() } }
        );

        return tx.hash;
    }

    async waitTxConfirmation( txHash: string, timeout_ms: number = 60_000 ): Promise<boolean>
    {
        if( !this.hasKupo() ) return false;
        timeout_ms = Math.abs( Number( timeout_ms ) );
        timeout_ms = Number.isSafeInteger( timeout_ms ) ? timeout_ms : 60_000;

        const timelimit = Date.now() + timeout_ms;
        
        while( true )
        {
            const utxos: any[] = await fetch(
                // tx_index@tx_hash = *@${txHash}
                `${this.kupoUrl}/matches/*@${txHash}?unspent`,
                typeof this.kupoApiKey === "string" ? { headers: { "dmtr-api-key": this.kupoApiKey } } : undefined
            ).then((res) => res.json());
    
            if(utxos && utxos.length > 0)
            {
                return true;
            }

            if( Date.now() > timelimit )
            {
                return false
            }

            await new Promise( r => setTimeout( r, 5000 ) );
        }
    }

    async resolveUtxo( u: CanResolveToUTxO ): Promise<UTxO | undefined>
    {
        return (await this.resolveUtxos([ u ]))[0];
    }

    async resolveUtxos( UTxOs: CanResolveToUTxO[] ): Promise<UTxO[]>
    {
        const outRefs = UTxOs.map( u => {
            if( isIUTxO( u ) ) u = u.utxoRef;
            if( isITxOutRef( u ) ) return new TxOutRef( u );
            return TxOutRef.fromString( u );
        });
        const queryHashes = [...new Set(outRefs.map( outRef => outRef.id.toString() ))];

        const utxos = await Promise.all(queryHashes.map(async (txHash) => {
            const result = await fetch(
                `${this.kupoUrl}/matches/*@${txHash}?unspent`,
                typeof this.kupoApiKey === "string" ? { headers: { "dmtr-api-key": this.kupoApiKey } } : undefined
            ).then((res) => res.json());
            if( !Array.isArray( result ) ) return [];
            return this.kupmiosUtxosToUtxos(result);
        }))
        .then( res => res.reduce( (acc, utxos) => acc.concat(utxos), [] ) );

        return utxos
            .filter(({ utxoRef }) =>
                outRefs.some( outRef =>
                    utxoRef.id.toString() === outRef.id.toString() &&
                    utxoRef.index === outRef.index
                )
            );
    }

    async getUtxosAt( address: Address | AddressStr ): Promise<UTxO[]>
    {
        address = address.toString() as AddressStr;

        const result = await fetch(
            `${this.kupoUrl}/matches/${address}?unspent`,
            typeof this.kupoApiKey === "string" ? { headers: { "dmtr-api-key": this.kupoApiKey } } : undefined
        ).then((res) => res.json());
        
        return this.kupmiosUtxosToUtxos(result);
    }

    async getUtxoByUnit( policy: Hash28 | Uint8Array, tokenName: Uint8Array = new Uint8Array): Promise<UTxO>
    {
        const policyId = policy instanceof Uint8Array ? toHex( policy ) : policy.toString();

        const assetName = toHex( tokenName );

        const result = await fetch(
            `${this.kupoUrl}/matches/${policyId}.${
                assetName.length > 0 ? `${assetName}` : "*"
            }?unspent`,
            typeof this.kupoApiKey === "string" ? { headers: { "dmtr-api-key": this.kupoApiKey } } : undefined
        ).then((res) => res.json());

        const utxos = await this.kupmiosUtxosToUtxos( result );
        
        if( utxos.length !== 1 )
        {
            throw new Error("getUtxoByUnit :: Unit needs to be an NFT or only held by one address.");
        }

        return utxos[0];
    }

    async getGenesisInfos( era: string = "conway" ): Promise<NormalizedGenesisInfos>
    {
        const result = {} as NormalizedGenesisInfos;

        let res = await this.ogmiosCall(
            "queryNetwork/startTime",
            { era }
        );

        (result as any).systemStartPosixMs = Date.parse( res ).valueOf();
        (result as any).slotLengthMs = 1000;
        (result as any).startSlotNo = 0;

        return result;
    }

    async getProtocolParameters(): Promise<ProtocolParameters>
    {
        const res = await this.ogmiosCall(
            "queryLedgerState/protocolParameters"
        );

        const costModels: CostModels = {};

        if( res.plutusCostModels )
        Object.keys(res.plutusCostModels).forEach((v) => {
            const version = v.split(":")[1]?.toUpperCase();
            if( typeof version !== "string" ) return;
            const plutusVersion = ("PlutusScript" + version) as ("PlutusScriptV1" | "PlutusScriptV2" | "PlutusScriptV3" ) ;
            costModels[plutusVersion] = res.plutusCostModels[v] as (CostModelPlutusV2Array & CostModelPlutusV1Array);
        });

        console.log( res );

        return {
            ...defaultProtocolParameters,
            txFeeFixed: BigInt( res.minFeeConstant?.ada?.lovelace ?? defaultProtocolParameters.txFeeFixed ),
            txFeePerByte: BigInt( res.minFeeCoefficient ?? defaultProtocolParameters.txFeePerByte ),
            maxTxSize: BigInt( res.maxTxSize ?? defaultProtocolParameters.maxTxSize ),
            maxValueSize: BigInt( res.maxValueSize?.bytes ?? defaultProtocolParameters.maxValueSize ),
            collateralPercentage: BigInt( res.collateralPercentage ?? defaultProtocolParameters.collateralPercentage ),
            stakeAddressDeposit: BigInt( res.stakeKeyDeposit ?? defaultProtocolParameters.stakeAddressDeposit ),
            stakePoolDeposit: BigInt( res.poolDeposit ?? defaultProtocolParameters.stakePoolDeposit ),
            executionUnitPrices:  res.scriptExecutionPrices ? {
                priceMemory: rationalFromString( res.scriptExecutionPrices.memory ).toNumber(),
                priceSteps: rationalFromString( res.scriptExecutionPrices.cpu ).toNumber()
            } : defaultProtocolParameters.executionUnitPrices,
            costModels,
            maxBlockExecutionUnits: new ExBudget({
                cpu: BigInt( res.maxExecutionUnitsPerBlock.cpu ),
                mem: BigInt( res.maxExecutionUnitsPerBlock.memory ),
            }),
            maxTxExecutionUnits: res.maxExecutionUnitsPerTransaction? new ExBudget({
                cpu: BigInt( res.maxExecutionUnitsPerTransaction.cpu ),
                mem: BigInt( res.maxExecutionUnitsPerTransaction.memory )
            }) : defaultProtocolParameters.maxTxExecutionUnits,
            utxoCostPerByte: BigInt( res.coinsPerUtxoByte ?? defaultProtocolParameters.utxoCostPerByte ),
            maxCollateralInputs: BigInt( res.maxCollateralInputs ?? defaultProtocolParameters.maxCollateralInputs ),
            maxBlockBodySize: BigInt( res.maxBlockBodySize?.bytes ?? defaultProtocolParameters.maxBlockBodySize ),
            maxBlockHeaderSize: BigInt( res.maxBlockHeaderSize?.bytes ?? defaultProtocolParameters.maxBlockHeaderSize ),
            minPoolCost: BigInt( res.minPoolCost ?? defaultProtocolParameters.minPoolCost ),
            monetaryExpansion: rationalFromString( res.monetaryExpansion ?? defaultProtocolParameters.monetaryExpansion ),
            poolPledgeInfluence: rationalFromString( res.stakePoolPledgeInfluence ?? defaultProtocolParameters.poolPledgeInfluence ),
            poolRetireMaxEpoch: BigInt(
                res.poolRetirementEpochBound ??
                defaultProtocolParameters.poolRetireMaxEpoch ??
                0
            ),
            protocolVersion: res.protocolVersion ? {
                major: res.version.major,
                minor: res.version.minor
            } : defaultProtocolParameters.protocolVersion,
            stakePoolTargetNum: BigInt(
                res.desiredNumberOfPools ??
                defaultProtocolParameters.stakePoolTargetNum ??
                0
            ),
            treasuryCut: rationalFromString( res.treasuryExpansion ?? defaultProtocolParameters.treasuryCut ),
            committeeTermLimit: BigInt(
                res.constitutionalCommitteeMaxTermLength ??
                defaultProtocolParameters.committeeTermLimit ??
                0
            ),
            drepActivityPeriod: BigInt( res.delegateRepresentativeMaxIdleTime ?? defaultProtocolParameters.drepActivityPeriod ),
            drepVotingThresholds: res.delegateRepresentativeVotingThresholds ? {
                ...defaultProtocolParameters.drepVotingThresholds,
                // committeeNoConfidence: ,
                // committeeNormal: ,
                // hardForkInitiation: ,
                // motionNoConfidence: ,
                // ppEconomicGroup: ,
                // ppGovGroup: ,
                // ppNetworkGroup: ,
                // ppTechnicalGroup: ,
                // treasuryWithdrawal: ,
                // updateConstitution: ,
            } : defaultProtocolParameters.drepVotingThresholds,
            drepDeposit: BigInt(
                res.delegateRepresentativeDeposit?.ada?.lovelace ??
                defaultProtocolParameters.drepDeposit ??
                0
            ),
            governanceActionDeposit: BigInt(
                res.governanceActionDeposit?.ada?.lovelace ??
                defaultProtocolParameters.governanceActionDeposit ??
                0
            ),
            governanceActionValidityPeriod: BigInt(
                res.governanceActionLifetime ??
                defaultProtocolParameters.governanceActionValidityPeriod
            ),
            minCommitteSize: Number(
                res.constitutionalCommitteeMinSize ??
                defaultProtocolParameters.minCommitteSize ??
                0
            ),
            minfeeRefScriptCostPerByte: defaultProtocolParameters.minfeeRefScriptCostPerByte ?? 0,
            poolVotingThresholds: defaultProtocolParameters.poolVotingThresholds ?? 0
        };
    }

    async waitOgmiosReady(): Promise<void>
    {
        this.ogmiosWs;
        while( !this.isOgmiosWsReady )
        {
            await new Promise( r => setTimeout( r, 1500 ) );
        }
    }
    async ogmiosCall(
        method: string,
        params?: object
    ): Promise<any>
    {
        await this.waitOgmiosReady();
        const self = this;

        const id = webcrypto.randomUUID();

        const promise: Promise<any> = new Promise((res, rej) => {
            function handler( msg: { data: any } )
            {
                try {
                    const json = JSON.parse( msg.data.toString() );
                    if( json.id !== id ) return;

                    self.ogmiosWs.removeEventListener("message", handler);
                    
                    if( json.error ) rej( json.error );
                    else res( json.result );
                }
                catch(e) {
                    self.ogmiosWs.removeEventListener("message", handler);
                    rej( e );
                }
            }
            this.ogmiosWs.addEventListener("message", handler);
        });

        params = typeof params !== "object" || !params ? undefined : params;

        this.ogmiosWs.send(JSON.stringify({
            jsonrpc: "2.0",
            method,
            params,
            id
        }));

        return promise;
    }

    async resolveDatumHash( datumHash: Hash32 | Uint8Array | string ): Promise<Data> {

        datumHash = datumHash instanceof Uint8Array ? toHex( datumHash ) : datumHash.toString();
        
        const result = await fetch(
          `${this.kupoUrl}/datums/${datumHash}`,
          typeof this.kupoApiKey === "string" ? { headers: { "dmtr-api-key": this.kupoApiKey } } : undefined
        ).then((res) => res.json());


        if (!result || !result.datum) {
            console.log( result );
            throw new Error(`No datum found for datum hash: ${datumHash}`);
        }

        return dataFromCbor( result.datum );
    }

    async resolveScriptHash( hash: Hash28 | Uint8Array | string ): Promise<Script> {

        hash = hash instanceof Uint8Array ? toHex( hash ) : hash.toString();
        
        const {
            script,
            language,
        } = await fetch(
            `${this.kupoUrl}/scripts/${hash}`,
            typeof this.kupoApiKey === "string" ? { headers: { "dmtr-api-key": this.kupoApiKey } } : undefined
        ).then((res) => res.json());

        const bytes = fromHex( script );

        if (language === "native")
        {
            return new Script(
                "NativeScript",
                bytes
            );
        } 
        else if (language === "plutus:v1")
        {
            return new Script(
                "PlutusScriptV1",
                bytes
            );
        }
        else if (language === "plutus:v2")
        {
            return new Script(
                "PlutusScriptV2",
                bytes
            );
        }

        throw new Error("unsupported script language: " + language);
    }

    private async kupmiosUtxosToUtxos(utxos: any[]): Promise<UTxO[]> {
        if( !Array.isArray( utxos ) ) return [];
        return Promise.all(
            utxos.map( async utxo => {

                const assets: { [unit: string ]: number } = utxo.value.assets;

                const units = Object.keys( assets );

                const datum = utxo.datum_type === "hash" ? new Hash32( utxo.datum_hash ) :
                utxo.datum_type === "inline" ? await this.resolveDatumHash( utxo.datum_hash ) :
                undefined;

                return new UTxO({
                    utxoRef: {
                        id: utxo.transaction_id,
                        index: parseInt(utxo.output_index)
                    },
                    resolved: {
                        address: utxo.address,
                        value: units.length > 0 ?
                            Value.add(
                                Value.lovelaces( utxo.value.coins ),
                                Value.fromUnits(
                                    units.map( unit => ({
                                        unit: unit.replace(".", ""),
                                        quantity: assets[unit]
                                    }))
                                )
                            ) :
                            Value.lovelaces( utxo.value.coins ),
                        datum,
                        refScript: typeof utxo.script_hash === "string" ? await this.resolveScriptHash( utxo.script_hash ) : undefined
                    }
                });
            })
        );
    }
}