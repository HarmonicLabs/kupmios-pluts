import { config } from "dotenv"
import { KupmiosPluts } from "../KupmiosPluts";
import { isPartialProtocolParameters, isProtocolParameters } from "@harmoniclabs/plu-ts";

config();

test("Kupmios.getProtocolParameters", async () => {

    const kupmios = new KupmiosPluts({
        kupoUrl: process.env.KUPO_URL ?? "" ,
        ogmiosUrl: process.env.OGMIOS_URL ?? ""

    });

    const pps = await kupmios.getProtocolParameters();
    kupmios.close();

    expect( isPartialProtocolParameters( pps ) ).toBe( true );
    expect( isProtocolParameters( pps ) ).toBe( true );

})