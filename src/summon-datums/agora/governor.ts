import {C, Credential, DatumHash, fromHex, PaymentKeyHash, ScriptHash, toHex} from 'lucid-cardano'
// import { PlutusData } from 'lucid-cardano/types/src/core/wasm_modules/cardano-multiplatform-lib-web/cardano_multiplatform_lib'
import {MAKE_MAYBE, MAKE_P_THRESHOLDS, MAKE_P_LOCK, MAKE_INDEXED_DATUM_STRING, PROPOSAL_THRESHOLD, PROPOSAL_TIMING_CONFIG,
     MAKE_INDEXED_DATUM, MAKE_CREDENTIAL, MAKE_CREDENTIAL_HEX, P_LOCK, STAKE_DATUM_TYPE} from './shared.js'

const GOVERNOR_DATUM = (
    thresholds: [BigInt, BigInt, BigInt, BigInt, BigInt],
    propId: BigInt,
    propTimings: [Date, Date, Date, Date, Date, Date],
    newProposalValidLength: Date,
    proposalsPerStake: BigInt
    ) => {
        const fieldsInner = C.PlutusList.new()
        const propThresholds = PROPOSAL_THRESHOLD(thresholds[0], thresholds[1], thresholds[2], thresholds[3], thresholds[4])
        const propTimingsPart = PROPOSAL_TIMING_CONFIG(propTimings[0], propTimings[1], propTimings[2], propTimings[3], propTimings[4], propTimings[5])
        const validLenDate = new Date(newProposalValidLength)
        if (validLenDate.valueOf() < 600000) throw new Error("Proposal valid length must be at least 10 minutes.")

        fieldsInner.add(propThresholds)
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(propId.toString())))
        fieldsInner.add(propTimingsPart)
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(validLenDate.valueOf().toString())))
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(proposalsPerStake.toString())))

        return toHex(fieldsInner.to_bytes());
}

const UPDATED_GOVERNOR = (
    thresholds: any,
    propId: number,
    propTimings: any,
    newProposalValidLength: any,
    proposalsPerStake: any
    ) => {
        const fieldsInner = C.PlutusList.new()

        fieldsInner.add(C.PlutusData.from_bytes(thresholds.to_bytes()))
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(propId.toString())))
        fieldsInner.add(C.PlutusData.from_bytes(propTimings.to_bytes()))
        fieldsInner.add(C.PlutusData.from_bytes(newProposalValidLength.to_bytes()))
        fieldsInner.add(C.PlutusData.from_bytes(proposalsPerStake.to_bytes()))

        return toHex(fieldsInner.to_bytes());
}

export const GOVERNOR_UPDATE_DATUM = (
    thresholds: any, //[BigInt, BigInt, BigInt, BigInt, BigInt],
    propId: any,
    propTimings: any, //[Date, Date, Date, Date, Date, Date],
    proposalsPerStake: any, //BigInt,
    proposalValidLength: any,
    newThresholds: [BigInt, BigInt, BigInt, BigInt, BigInt],
    newPropTimings: [Date, Date, Date, Date, Date, Date],
    newNewProposalValidLength: Date,
    newProposalsPerStake: BigInt
) => {
    const outerList = C.PlutusList.new()
    const fieldsInner = C.PlutusList.new()

    fieldsInner.add(C.PlutusData.from_bytes(thresholds.to_bytes()))
    fieldsInner.add(C.PlutusData.from_bytes(propId.to_bytes()))
    fieldsInner.add(C.PlutusData.from_bytes(propTimings.to_bytes()))
    fieldsInner.add(C.PlutusData.from_bytes(proposalValidLength.to_bytes()))
    fieldsInner.add(C.PlutusData.from_bytes(proposalsPerStake.to_bytes()))

    const newFieldsInner = C.PlutusList.new()
    const newPropThresholds = PROPOSAL_THRESHOLD(newThresholds[0], newThresholds[1], newThresholds[2], newThresholds[3], newThresholds[4])
    const newPropTimingsPart = PROPOSAL_TIMING_CONFIG(newPropTimings[0], newPropTimings[1], newPropTimings[2], newPropTimings[3], newPropTimings[4], newPropTimings[5])
    const newValidLenDate = new Date(newNewProposalValidLength)
    if (newValidLenDate.valueOf() < 600000) throw new Error("Proposal valid length must be at least 10 minutes.")

    newFieldsInner.add(newPropThresholds)
    newFieldsInner.add(C.PlutusData.from_bytes(propId.to_bytes()))
    newFieldsInner.add(newPropTimingsPart)
    newFieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(newValidLenDate.valueOf().toString())))
    newFieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(newProposalsPerStake.toString())))

    outerList.add(C.PlutusData.new_list(fieldsInner))
    outerList.add(C.PlutusData.new_list(newFieldsInner))
    return toHex(outerList.to_bytes());
}

const CREATE_PROPOSAL_REDEEMER = () => { // These are currently just enum, use integer.
    return toHex(C.PlutusData.new_integer(C.BigInt.from_str("0")).to_bytes()) 
}

const MINT_GAT_REDEEMER = () => {
    return toHex(C.PlutusData.new_integer(C.BigInt.from_str("1")).to_bytes())
}

const MUTATE_GOVERNOR_REDEEMER = () => {
    return toHex(C.PlutusData.new_integer(C.BigInt.from_str("2")).to_bytes())
}

export {GOVERNOR_DATUM, UPDATED_GOVERNOR, CREATE_PROPOSAL_REDEEMER, MINT_GAT_REDEEMER, MUTATE_GOVERNOR_REDEEMER}