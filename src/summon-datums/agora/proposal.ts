import {C, Credential, DatumHash, fromHex, PaymentKeyHash, ScriptHash, toHex} from 'lucid-cardano'
import {MAKE_MAYBE, MAKE_P_THRESHOLDS, MAKE_P_LOCK, MAKE_INDEXED_DATUM_STRING, PROPOSAL_TIMING_CONFIG, PROPOSAL_THRESHOLD,
     MAKE_INDEXED_DATUM, MAKE_CREDENTIAL, MAKE_CREDENTIAL_HEX, P_LOCK, STAKE_DATUM_TYPE} from './shared.js'

const PROPOSAL_DATUM = (
    propId: any,
    effects: Map<BigInt, Map<ScriptHash, [arg0: DatumHash, arg1: ScriptHash | undefined]>>,
    status: BigInt,
    cosigners: Credential[],
    thresholds: any,
    votes: Map<BigInt, BigInt>,
    timingConfig: any,
    startingTime: Date
    ) => {
        const fieldsInner = C.PlutusList.new()
        const startingTimeDate = new Date(startingTime)
        // Add propId
        fieldsInner.add(C.PlutusData.from_bytes(propId.to_bytes()))

        // Add EffectMap
        const effectMap = C.PlutusMap.new()
        const voteMap = C.PlutusMap.new()
        for(let key of effects.keys()) {
            const innerEffectMap = C.PlutusMap.new()
            const innerMap = effects.get(key) as Map<ScriptHash, [arg0: DatumHash, arg1: ScriptHash | undefined]>
            const innerKeys = [...innerMap.keys()].sort((a, b) => a.localeCompare(b))
            for(let script of innerKeys) {
                const effectGroupList = C.PlutusList.new()
                const datum = innerMap.get(script) as [arg0: DatumHash, arg1: ScriptHash | undefined]
                effectGroupList.add(C.PlutusData.new_bytes(Buffer.from(datum[0], 'hex')))
                if (datum[1] == undefined) {
                    effectGroupList.add(MAKE_MAYBE(undefined))
                } else {
                    effectGroupList.add(MAKE_MAYBE(C.PlutusData.new_bytes(fromHex(datum[1]))))
                }
                innerEffectMap.insert(C.PlutusData.new_bytes(Buffer.from(script, 'hex')), C.PlutusData.new_list(effectGroupList))
            }
            effectMap.insert(C.PlutusData.new_integer(C.BigInt.from_str(key.toString())), C.PlutusData.new_map(innerEffectMap))
        }
        fieldsInner.add(C.PlutusData.new_map(effectMap))

        // Add status
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(status.toString()))) // This is an enum

        // Add cosigners
        const coSigners = C.PlutusList.new()
        cosigners.forEach((cosigner) => {
            coSigners.add(MAKE_CREDENTIAL(cosigner))
        })
        fieldsInner.add(C.PlutusData.new_list(coSigners))

        // Add thresholds
        fieldsInner.add(C.PlutusData.from_bytes(thresholds.to_bytes()))


        // Add votes -- Appears to be working but may be a problem area.
        for(let key of votes.keys()) {
            let voted = votes.get(key)
            voted = voted ? voted : 0n;
            voteMap.insert(C.PlutusData.new_integer(C.BigInt.from_str(key.toString())), C.PlutusData.new_integer(C.BigInt.from_str(voted.toString())))
        }
        const votesInner = C.PlutusMap.new()
        fieldsInner.add(C.PlutusData.new_map(voteMap))

        fieldsInner.add(C.PlutusData.from_bytes(timingConfig.to_bytes()))

        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(startingTimeDate.valueOf().toString())))

        return toHex(fieldsInner.to_bytes())

    }

const UPDATE_PROPOSAL_PURE_DATUM = (
    propId: any,
    effects: any,
    status: any,
    cosigners: any,
    thresholds: any,
    votes: any,
    timingConfig: any,
    startingTime: any
    ) => {
        try {
            const fieldsInner = C.PlutusList.new()
            fieldsInner.add(C.PlutusData.from_bytes(propId.to_bytes()))
            fieldsInner.add(C.PlutusData.from_bytes(effects.to_bytes()))
            fieldsInner.add(C.PlutusData.from_bytes(status.to_bytes()))
            fieldsInner.add(C.PlutusData.from_bytes(cosigners.to_bytes()))
            fieldsInner.add(C.PlutusData.from_bytes(thresholds.to_bytes()))
            fieldsInner.add(C.PlutusData.from_bytes(votes.to_bytes()))
            fieldsInner.add(C.PlutusData.from_bytes(timingConfig.to_bytes()))
            fieldsInner.add(C.PlutusData.from_bytes(startingTime.to_bytes()))

            return toHex(fieldsInner.to_bytes())
        } catch (e) {
            console.log(e)
            throw e
        }
    }

const UPDATE_PROPOSAL_VOTE_DATUM = (
    propId: any,
    effects: any,
    status: any,
    cosigners: any,
    thresholds: any,
    votes: Map<BigInt, BigInt>,
    timingConfig: any,
    startingTime: any
    ) => {
        try {
            const fieldsInner = C.PlutusList.new()
            // Add propId
            fieldsInner.add(C.PlutusData.from_bytes(propId.to_bytes()))
            fieldsInner.add(C.PlutusData.from_bytes(effects.to_bytes()))
            fieldsInner.add(C.PlutusData.from_bytes(status.to_bytes()))
            fieldsInner.add(C.PlutusData.from_bytes(cosigners.to_bytes()))
            fieldsInner.add(C.PlutusData.from_bytes(thresholds.to_bytes()))

            const voteMap = C.PlutusMap.new()
            for(let key of votes.keys()) {
                let voted = votes.get(key)
                voted = voted ? voted : 0n;
                voteMap.insert(C.PlutusData.new_integer(C.BigInt.from_str(key.toString())), C.PlutusData.new_integer(C.BigInt.from_str(voted.toString())))
            }
            fieldsInner.add(C.PlutusData.new_map(voteMap))
            fieldsInner.add(C.PlutusData.from_bytes(timingConfig.to_bytes()))
            fieldsInner.add(C.PlutusData.from_bytes(startingTime.to_bytes()))
    
            return toHex(fieldsInner.to_bytes())
        } catch (e) {
            console.log(e)
            throw e
        }
    }


const PROPOSAL_VOTE_REDEEMER = (result: BigInt) => {
    const fieldsInner = C.PlutusList.new()
    fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(result.toString())))
    const redeemer = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(C.BigNum.from_str("0"),
        fieldsInner)
    )
    return toHex(redeemer.to_bytes())
}

const PROPOSAL_COSIGN_REDEEMER = () => {
    const fieldsInner = C.PlutusList.new()
    const redeemer = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(C.BigNum.from_str("1"),
        fieldsInner)
    )
    return toHex(redeemer.to_bytes());
}
const PROPOSAL_UNLOCK_REDEEMER = () => {
    const fieldsInner = C.PlutusList.new()
    const redeemer = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(C.BigNum.from_str("2"),
        fieldsInner)
    )
    return toHex(redeemer.to_bytes())
}
const PROPOSAL_ADVANCE_REDEEMER = () => {
    const fieldsInner = C.PlutusList.new()
    const redeemer = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(C.BigNum.from_str("3"),
        fieldsInner)
    )
    return toHex(redeemer.to_bytes())
}

export {PROPOSAL_ADVANCE_REDEEMER, PROPOSAL_COSIGN_REDEEMER, PROPOSAL_DATUM, PROPOSAL_THRESHOLD, PROPOSAL_TIMING_CONFIG, PROPOSAL_UNLOCK_REDEEMER, PROPOSAL_VOTE_REDEEMER, UPDATE_PROPOSAL_PURE_DATUM, UPDATE_PROPOSAL_VOTE_DATUM}