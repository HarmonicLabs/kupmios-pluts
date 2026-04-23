# @harmoniclabs/kupmios-pluts

A thin TypeScript client that combines [Kupo](https://cardanosolutions.github.io/kupo/) and [Ogmios](https://ogmios.dev/) into a single interface, returning [`@harmoniclabs/buildooor`](https://github.com/HarmonicLabs/buildooor) values (`UTxO`, `Tx`, `ProtocolParameters`, `Script`, `Data`, …) for off-chain Cardano dApp code.

## What it does

Off-chain Cardano code typically needs two things from the network: a way to read the current ledger state (UTxOs, datums, scripts, protocol parameters) and a way to submit transactions. This package glues three pieces together so you don't have to:

- **Kupo** — a fast UTxO / datum / script indexer queried over HTTP REST, used here for anything state-related.
- **Ogmios** — the Cardano node query & submission protocol, used here over a JSON-RPC 2.0 WebSocket for protocol parameters, genesis info, and transaction submission.
- **`@harmoniclabs/buildooor`** — provides the typed Cardano data structures; every method returns buildooor values rather than raw Kupo/Ogmios JSON.

`KupmiosPluts` is the only export and is intended to be passed to (or used alongside) buildooor's transaction builder.

## Installation

```sh
npm install @harmoniclabs/kupmios-pluts
```

You will almost always want `@harmoniclabs/buildooor` installed alongside it, since its types (`Address`, `Tx`, `UTxO`, `Hash28`, `Hash32`, `ProtocolParameters`, …) appear in this package's public API:

```sh
npm install @harmoniclabs/buildooor
```

## Quick start

```ts
import { KupmiosPluts } from "@harmoniclabs/kupmios-pluts";

const kupmios = new KupmiosPluts({
    kupoUrl: process.env.KUPO_URL,
    ogmiosUrl: process.env.OGMIOS_URL,
    // kupoApiKey: "..."  // e.g. for Demeter.run hosted endpoints
});

const pps = await kupmios.getProtocolParameters();
const utxos = await kupmios.getUtxosAt(someAddress);

kupmios.close();
```

The Ogmios WebSocket is created lazily on first use, so constructing a `KupmiosPluts` is cheap and doesn't open any network connection on its own.

## Configuration

The constructor takes a `KupmiosPlutsConfig`:

| Field         | Type                   | Purpose                                                                 |
| ------------- | ---------------------- | ----------------------------------------------------------------------- |
| `kupoUrl`     | `string \| undefined`  | Base URL of a Kupo instance. Required for any Kupo-backed method.       |
| `ogmiosUrl`   | `string \| undefined`  | WebSocket URL of an Ogmios instance. Required for any Ogmios-backed method. |
| `kupoApiKey`  | `string \| undefined`  | Optional. Sent as the `dmtr-api-key` header on Kupo requests (Demeter.run convention). |

Both endpoints are independently optional — you can instantiate with only Kupo if you just need state queries, or only Ogmios if you just need protocol params and submission. Use `hasKupo()` to check whether Kupo is configured; `waitTxConfirmation` gracefully returns `false` when it isn't.

## API reference

All methods are on the `KupmiosPluts` instance.

### State queries (Kupo)

| Method                                                            | Description                                                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `getUtxosAt(address: Address \| AddressStr)`                      | Returns all unspent UTxOs at a Cardano address, with inline datums and reference scripts resolved. |
| `getUtxoByUnit(policy, tokenName?)`                               | Looks up the UTxO holding a given native asset. Throws unless exactly one unspent output matches (i.e. an NFT or a uniquely-held token). |
| `resolveUtxo(u: CanResolveToUTxO)`                                | Resolves a single UTxO reference to a full `UTxO`.                                                 |
| `resolveUtxos(UTxOs: CanResolveToUTxO[])`                         | Batch version — accepts `ITxOutRef`, `IUTxO`, or `string` inputs and parallelizes by transaction hash. |
| `resolveDatumHash(hash)`                                          | Fetches a full datum from Kupo by hash and returns it as a buildooor `Data`.                       |
| `resolveScriptHash(hash)`                                         | Fetches a script by hash and returns a buildooor `Script`. Supports `native`, `plutus:v1`, `plutus:v2`, `plutus:v3`. |
| `waitTxConfirmation(txHash, timeout_ms = 60_000)`                 | Polls Kupo every 5 seconds for any unspent output produced by `txHash`. Returns `true` on confirmation, `false` on timeout (or when Kupo is not configured). |

### Network queries & submission (Ogmios)

| Method                                 | Description                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `getProtocolParameters()`              | Returns current protocol parameters as a buildooor `ProtocolParameters`, including PlutusV1/V2/V3 cost models. Conway governance fields are partially populated. |
| `getGenesisInfos(era = "conway")`      | Returns `NormalizedGenesisInfos` with `systemStartPosixMs`, `slotLengthMs`, and `startSlotNo`. |
| `submitTx(tx: Tx)`                     | Submits a transaction via Ogmios and returns its `Hash32`.                                     |
| `ogmiosCall(method, params?)`          | Low-level JSON-RPC 2.0 escape hatch for arbitrary Ogmios methods.                              |

### Lifecycle

| Method                   | Description                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `hasKupo()`              | `true` if `kupoUrl` was provided.                                                           |
| `waitOgmiosReady()`      | Resolves once the Ogmios WebSocket is open. Called internally by `ogmiosCall`.              |
| `close()`                | Closes the Ogmios WebSocket. Safe to call when no connection was ever opened.               |
| `[Symbol.dispose]()`     | Delegates to `close()` so instances can be used with `using` (TC39 explicit resource management). |

## Submitting a transaction

Build the transaction with `@harmoniclabs/buildooor`, then submit and wait for confirmation:

```ts
import { KupmiosPluts } from "@harmoniclabs/kupmios-pluts";
// build `tx: Tx` with @harmoniclabs/buildooor ...

const kupmios = new KupmiosPluts({
    kupoUrl: process.env.KUPO_URL,
    ogmiosUrl: process.env.OGMIOS_URL,
});

try {
    const txHash = await kupmios.submitTx(tx);
    const confirmed = await kupmios.waitTxConfirmation(txHash.toString(), 120_000);
    if (!confirmed) throw new Error(`Transaction ${txHash} not confirmed within timeout`);
} finally {
    kupmios.close();
}
```

Or with explicit resource management:

```ts
using kupmios = new KupmiosPluts({ kupoUrl, ogmiosUrl });
const txHash = await kupmios.submitTx(tx);
await kupmios.waitTxConfirmation(txHash.toString());
```

## Scripts

| Command              | Does                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `npm test`           | Runs the Jest test suite (requires `KUPO_URL` / `OGMIOS_URL` in `.env`). |
| `npm run build`      | Clean build — removes `./dist`, then runs `tsc` + `tsc-alias`.       |
| `npm run build:light`| Incremental build without clearing `dist`.                           |
| `npm run ci`         | `npm test && npm run build`.                                         |

## Requirements

- **Node.js 18+** — the implementation relies on `globalThis.fetch`, `crypto.webcrypto.randomUUID`, and the `ws` package.
- **TypeScript** — shipped as CommonJS (`"type": "commonjs"`, `target: "es5"`, `module: "CommonJS"`); declaration files are emitted alongside the compiled output.

## License & attribution

Apache-2.0 — author Michele Nuzzi ([HarmonicLabs](https://github.com/HarmonicLabs)).

If you'd like to support the work: [GitHub Sponsors — HarmonicLabs](https://github.com/sponsors/HarmonicLabs).
