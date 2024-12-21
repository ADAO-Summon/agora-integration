export const DATUM_KEY = 901

export const postDatum = async (datum: string) : Promise<string> => {
    let body = {datum: datum}
    // body.set('datum', datum) // = datum
    let returnV = await fetch(`${process.env.ARWEAVE_POST_PORT}/postDatum`, {
        method: "POST", //body ? "POST" : "GET",
        body: JSON.stringify(body), //JSON.stringify(body),
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }).then((response: any) => {
        if (!response.ok) {
        throw new Error(response.status.toString());
        }
        return response.json();
    });
    return returnV.txId
}