import { CborPositiveRational } from "@harmoniclabs/cbor";

export function rationalFromString( str: string | CborPositiveRational | number ): CborPositiveRational
{
    if( typeof str === "number" ) return CborPositiveRational.fromNumber( str );
    if( str instanceof CborPositiveRational ) return str;
    
    const [ numStr, denStr ] = str.split("/");
    return new CborPositiveRational( BigInt( numStr ), BigInt( denStr ) );
}