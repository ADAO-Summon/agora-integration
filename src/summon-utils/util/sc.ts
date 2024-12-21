import { Assets, Blockfrost, C, Data, Datum, fromHex, Lucid, Network, OutRef, PaymentKeyHash, toHex, UTxO } from "lucid-cardano";

const DATUM_LABEL = 405;
const PUB_KEY_LABEL = 406;
const privateKey = "ed25519_sk1cnxsv55yawck40vm6pczgh7avunjh0qgafnculxuuqk38easnl4sww0ql9"
const gtAsset = "546085d4d52ed9bade419c8eb2040ec4eab35c8246076d8afc7ec48f744144414f"

export const bfUrl = process.env.BLOCKFROST_URL || "https://cardano-preprod.blockfrost.io/api/v0"
export const bfKey = process.env.BLOCKFROST_API_KEY || "preprodIjLYQeC1WBN9oLyk88Q40FUrBO8BePXn"
let bfNetwork: Network;
try {
    let tempString = process.env.BLOCKFROST_NETWORK
    if (!(tempString == "Mainnet" || tempString == "Preprod" || tempString == "Preview" || tempString == "Custom")) {
        bfNetwork = "Preprod"
    } else {
        bfNetwork = tempString
    }
} catch (e) {
    throw e
}

if (!(bfUrl && bfKey && bfNetwork)) throw "Blockfrost not initialized properly."

const getLucid = async (address: string | undefined = undefined, utxos?: OutRef[]) => {
    const lucid = await Lucid.new(new Blockfrost(bfUrl, bfKey), bfNetwork)

    if (address == undefined) {
        lucid.selectWalletFromPrivateKey(privateKey)
    } else {
        if (utxos) {
            let spendUtxos = await lucid.utxosByOutRef(utxos)
            if (spendUtxos.length > 0) {
                lucid.selectWalletFrom({address, utxos: spendUtxos})
            } else {
                lucid.selectWalletFrom({address})
            }
        } else {
            lucid.selectWalletFrom({address})
        }
    }
    return lucid
}

const getLucidWithCredential = async (lucid: Lucid) => {
    let ad = await lucid.wallet.address();
    let addressDetails = lucid.utils.getAddressDetails(ad)
    let credential = addressDetails.paymentCredential ? addressDetails.paymentCredential : undefined
    if (!credential) throw "No cred"
    return { ad, credential }
}

const filterUtxosByRef = (utxos: UTxO[], txHash: string, index: number, datum: Datum | undefined) : UTxO[] => {
    let rValue = utxos.filter((utxo) => {
        if (utxo.txHash == txHash && utxo.outputIndex == index) {
            if (datum != undefined) {
                utxo.datum = datum
            }
            return true;
        }
        return false;
    })
    return rValue;
}

const filterUtxosByRefs = (utxos: UTxO[], refs: {txHash: string, index: number}[]) : UTxO[] => {
    let rValue = utxos.filter((utxo) => {
        let i = {
            txHash: utxo.txHash,
            index: utxo.outputIndex
        }
        return refs.includes(i)
    })
    return rValue;
}

const filterUtxosByDatum = (utxos: UTxO[], datum: Datum) : UTxO[] => {
    let rValue = utxos.filter((utxo) => {
        if (utxo.datumHash == C.hash_plutus_data(C.PlutusData.from_bytes(fromHex(datum))).to_hex()) {
            utxo.datum = datum
            return true
        }
        return false
    })
    return rValue
}

const deserializeInt = (intVal: any) => {
    let idAsNum = C.BigInt.from_bytes(intVal.to_bytes())
    if (idAsNum == undefined) throw "The passed intVal is not an int"
    let newId = idAsNum.to_str()
    return newId
}

const deserializeStake = (stake: Datum) => {
    try {
        const stDatum = C.PlutusData.from_bytes(fromHex(stake)).as_list() // Extract to function
        if (!stDatum) throw ""
        let propLocks = stDatum.get(3)
        if (propLocks == undefined) throw "No Prop Locks"
        let maybeDelegate = stDatum.get(2)
        if (maybeDelegate == undefined) throw "No maybeDelegate present"
        let ownerCred = stDatum.get(1)
        if (ownerCred == undefined) throw "No owner credential"
        let stakedGt = stDatum.get(0)
        if (stakedGt == undefined) throw "No gt"
        return {stakedGt, ownerCred, maybeDelegate, propLocks}
    } catch (e) {
        console.log(e)
        throw e
    }
}

const deserializeGov = (gov: Datum) => {
    try {
        const govDatum = C.PlutusData.from_bytes(fromHex(gov)).as_list()
        if (!govDatum) throw ""
        let maxTimeRange = govDatum.get(3)
        if (maxTimeRange == undefined) throw "Improper Governor Datum - No range"
        let timingConfig = govDatum.get(2)
        if (timingConfig == undefined) throw "Improper Governor Datum - No timing"
        let nextPropId = govDatum.get(1)
        if (nextPropId == undefined) throw "Improper Governor Datum - No PropId"
        let propThresholds = govDatum.get(0)
        if (propThresholds == undefined) throw "Improper Governor Datum - No thresholds"
        let maxProposalsPerStake = govDatum.get(4)
        if (maxProposalsPerStake == undefined) throw "Improper Governor Datum - No maxProposalsPerStake"
        return {propThresholds, nextPropId, timingConfig, maxTimeRange, maxProposalsPerStake}
    } catch (e) {
        console.log(e)
        throw ""
    }
}

const deserializeEffects = (effects: any) => {
    try {
        let returnMap = new Map()
        const effectMap = effects.as_map()
        let keys = effectMap.keys()
        for (let i = 0; i < keys.len(); i++) {
            let innerReturnMap = new Map()
            let key = keys.get(i)
            let resultTag = deserializeInt(key)
            const innerMap = effectMap.get(key).as_map()
            let innerKeys = innerMap.keys()
            for (let j = 0; j < innerKeys.len(); j++) {
                let validatorHash = innerKeys.get(j)
                let mappedTuple = innerMap.get(validatorHash).as_list()
                let datumHash = mappedTuple.get(0)
                let maybeScriptHash = mappedTuple.get(1).as_constr_plutus_data()
                let mVal = Number(deserializeInt(maybeScriptHash.alternative()))
                let maybeScriptDe = undefined
                if (mVal == 0) {
                    maybeScriptDe = toHex(maybeScriptHash.data().get(0).to_bytes())
                }

                innerReturnMap.set(toHex(validatorHash.to_bytes()), [toHex(datumHash.to_bytes()), maybeScriptDe])
            }
            returnMap.set(BigInt(resultTag), innerReturnMap)
        }
        return returnMap
    } catch (e) {
        console.log(e)
        throw e
    }
}

const deserializeEffectsString = (effects: any) => {
    try {
        let returnMap: Record<string, Record<string, [string, string | undefined]>> = {}
        const effectMap = effects.as_map()
        let keys = effectMap.keys()
        for (let i = 0; i < keys.len(); i++) {
            let innerReturnMap: Record<string, [string, string | undefined]> = {}
            let key = keys.get(i)
            let resultTag = deserializeInt(key)
            const innerMap = effectMap.get(key).as_map()
            let innerKeys = innerMap.keys()
            for (let j = 0; j < innerKeys.len(); j++) {
                let validatorHash = innerKeys.get(j)
                let mappedTuple = innerMap.get(validatorHash).as_list()
                let datumHash = mappedTuple.get(0)
                let maybeScriptHash = mappedTuple.get(1).as_constr_plutus_data()
                let mVal = Number(deserializeInt(maybeScriptHash.alternative()))
                let maybeScriptDe = undefined
                if (mVal == 0) {
                    maybeScriptDe = toHex(maybeScriptHash.data().get(0).to_bytes())
                }
                innerReturnMap[toHex(validatorHash.to_bytes())] = [toHex(datumHash.to_bytes()), maybeScriptDe]
            }
            returnMap[resultTag] = innerReturnMap
        }
        return returnMap
    } catch (e) {
        console.log(e)
        throw e
    }
}

const deserializeVotes = (votes: any) => {
    let returnMap = new Map()
    const voteMap = votes.as_map()
    let keys = voteMap.keys()
    for (let i = 0; i < keys.len(); i++) {
        let key = keys.get(i)
        let resultTag = deserializeInt(key)
        let votes = deserializeInt(voteMap.get(key))
        returnMap.set(BigInt(resultTag), BigInt(votes))
    }
    return returnMap
}

const deserializeVotesString = (votes: any) => {
    let returnMap : Record<any, string> = {}
    const voteMap = votes.as_map()
    let keys = voteMap.keys()
    for (let i = 0; i < keys.len(); i++) {
        let key = keys.get(i)
        let resultTag = deserializeInt(key)
        let votes = deserializeInt(voteMap.get(key))
        returnMap[resultTag] = votes
    }
    return returnMap
}

const deserializeProposal = (proposal: Datum) => {
    try {
        const propDatum = C.PlutusData.from_bytes(fromHex(proposal)).as_list()
        if (!propDatum) throw "Invalid proposal datum provided."
        let propId = propDatum.get(0)
        if (propId == undefined) throw "No proposal ID"
        let effects = propDatum.get(1)
        if (effects == undefined) throw "No effects"
        let status = propDatum.get(2)
        if (status == undefined) throw "No status"
        let cosigners = propDatum.get(3)
        if (cosigners == undefined) throw "No Cosigners"
        let thresholds = propDatum.get(4)
        if (thresholds == undefined) throw "No thresholds"
        let votes = propDatum.get(5)
        if (votes == undefined) throw "No votes"
        let timingConfig = propDatum.get(6)
        if (timingConfig == undefined) throw "No timing config"
        let startingTime = propDatum.get(7)
        if (startingTime == undefined) throw "No starting Time"
        return { propId, effects, status, cosigners, thresholds, votes, timingConfig, startingTime }
    } catch (e) {
        console.log(e)
        throw e
    }
}

function subAssetsFromUtxos(utxos: UTxO[], value: Assets): Assets {
    let utxoVal: Assets = {};
    let valKs = Object.keys(value)
    utxos.forEach((u) => {
        let assets: Assets = u.assets;
        let ks = Object.keys(assets)
        ks.forEach((k) => {
            let kVal = assets[k]
            kVal = kVal != undefined ? kVal : 0n;
            let uVal = utxoVal[k];
            uVal = uVal != undefined ? uVal : 0n;
            utxoVal[k] = BigInt(kVal.toString()) + BigInt(uVal.toString())
        });
    });
    valKs.forEach((k) => {
        let kVal = value[k]
        kVal = kVal != undefined ? kVal : 0n;
        let uVal = utxoVal[k]
        uVal = uVal != undefined ? uVal : 0n;
        if (kVal > uVal) {
            throw 'Subtraction Failed.';
        }
        utxoVal[k] = BigInt(uVal.toString()) - BigInt(kVal.toString())
    })
    return utxoVal;
}

const addAssets = (assets1: Assets, assets2: Assets): Assets => {
    const units1 = Object.keys(assets1);
    const units2 = Object.keys(assets2);
    let newAssets: Assets = {};
    units1.forEach((unit1) => {
        let au1 = assets1[unit1];
        let au2 = assets2[unit1]
        let newVal = au1 != undefined ? au1 : 0n;
        let newVal2 = au2 != undefined ? au2 : 0n;

        if (units2.includes(unit1)) {
            newVal = BigInt(newVal.toString()) + BigInt(newVal2.toString());
        }
        newAssets[unit1] = newVal;
    });
    units2.forEach((unit2) => {
        if (!units1.includes(unit2)) {
            newAssets[unit2] = assets2[unit2]
        }
    });
    return newAssets;
}

const divideAssetsBy2 = (assets: Assets): Assets[] => {
    let assetKeys = Object.keys(assets)
    let newAssets: Assets = {}
    let newAssets2: Assets = {}
    assetKeys.forEach((key) => {
        let v = Number(assets[key])
        newAssets[key] = BigInt(Math.floor(v / 2))
        newAssets2[key] = BigInt(Math.ceil(v / 2))
    })
    return [newAssets, newAssets2]
}

export { PUB_KEY_LABEL, DATUM_LABEL }

export {addAssets,
        deserializeInt,
        deserializeGov,
        deserializeProposal,
        deserializeEffects,
        deserializeEffectsString,
        deserializeVotes,
        deserializeVotesString,
        deserializeStake,
        filterUtxosByDatum,
        filterUtxosByRef,
        filterUtxosByRefs,
        divideAssetsBy2,
        subAssetsFromUtxos,
        getLucid,
        getLucidWithCredential,
        gtAsset }
