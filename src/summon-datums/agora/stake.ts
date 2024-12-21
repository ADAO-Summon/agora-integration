import {C, Credential, DatumHash, fromHex, PaymentKeyHash, ScriptHash, toHex} from 'lucid-cardano'
import {MAKE_MAYBE, MAKE_P_THRESHOLDS, MAKE_P_LOCK, MAKE_INDEXED_DATUM_STRING,
     MAKE_INDEXED_DATUM, MAKE_CREDENTIAL, MAKE_CREDENTIAL_HEX, P_LOCK, STAKE_DATUM_TYPE} from './shared.js'

const STAKE_REDEEMER_TYPE = {
    DepositWithdraw: 0,
    Destroy: 1,
    PermitVote: 2,
    RetractVote: 3,
    DelegateTo: 4,
    ClearDelegate: 5
}

const STAKE_DATUM = (amount: BigInt, pkh: Credential, delegatedTo: Credential | undefined, plocks: any) => {
    const fieldsInner = C.PlutusList.new()
    fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(amount.toString())))
    fieldsInner.add(MAKE_CREDENTIAL(pkh))
    if (delegatedTo == undefined) {
        fieldsInner.add(MAKE_MAYBE(delegatedTo))
    } else {
        fieldsInner.add(MAKE_MAYBE(MAKE_CREDENTIAL(delegatedTo)))
    }
    fieldsInner.add(C.PlutusData.from_bytes(plocks.to_bytes()))
    const datum = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(
            C.BigNum.from_str(STAKE_DATUM_TYPE.StakeDatum.toString()),
            fieldsInner
        )
    )
    return toHex(fieldsInner.to_bytes());
}

const UPDATE_PURE_STAKE_DATUM = (amount: any, cred: any, delegate: any, plocks: any) => {
    const fieldsInner = C.PlutusList.new()
    fieldsInner.add(C.PlutusData.from_bytes(amount.to_bytes()))
    fieldsInner.add(C.PlutusData.from_bytes(cred.to_bytes()))
    fieldsInner.add(C.PlutusData.from_bytes(delegate.to_bytes()))
    fieldsInner.add(C.PlutusData.from_bytes(plocks.to_bytes()))
    const datum = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(
            C.BigNum.from_str(STAKE_DATUM_TYPE.StakeDatum.toString()),
            fieldsInner
        )
    )
    return toHex(fieldsInner.to_bytes());
}

const UPDATE_AMOUNT_STAKE_DATUM = (amount: BigInt, pkh: Credential, delegatedTo: any, plocks: any) => {
    const fieldsInner = C.PlutusList.new()
    fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(amount.toString())))
    fieldsInner.add(MAKE_CREDENTIAL(pkh))
    fieldsInner.add(C.PlutusData.from_bytes(delegatedTo.to_bytes()))
    fieldsInner.add(C.PlutusData.from_bytes(plocks.to_bytes()))
    const datum = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(
            C.BigNum.from_str(STAKE_DATUM_TYPE.StakeDatum.toString()),
            fieldsInner
        )
    )
    return toHex(fieldsInner.to_bytes());
}

const DEPOSIT_WITHDRAW_REDEEMER = (amount: BigInt) => {
    const fieldsInner = C.PlutusList.new()
    fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(amount.toString())))
    const redeemer = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(
            C.BigNum.from_str(STAKE_REDEEMER_TYPE.DepositWithdraw.toString()),
            fieldsInner
        )
    )
    return toHex(redeemer.to_bytes());
}

const DESTROY_STAKE_REDEEMER = () => {
    const redeemer = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(
            C.BigNum.from_str(STAKE_REDEEMER_TYPE.Destroy.toString()),
            C.PlutusList.new()
        )
    )
    return toHex(redeemer.to_bytes());
}

const PERMIT_VOTE_REDEEMER = () => {
    const fieldsInner = C.PlutusList.new()
    const redeemer = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(
            C.BigNum.from_str(STAKE_REDEEMER_TYPE.PermitVote.toString()),
            fieldsInner
        )
    )
    return toHex(redeemer.to_bytes());
}

const RETRACT_VOTE_REDEEMER = () => {
    const fieldsInner = C.PlutusList.new()
    const redeemer = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(
            C.BigNum.from_str(STAKE_REDEEMER_TYPE.RetractVote.toString()),
            fieldsInner
        )
    )
    return toHex(redeemer.to_bytes());
}

const DELEGATE_TO_REDEEMER = (delegatedTo: Credential) => {
    const inner = C.PlutusList.new()
    inner.add(MAKE_CREDENTIAL(delegatedTo))
    const redeemer = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(
            C.BigNum.from_str(STAKE_REDEEMER_TYPE.DelegateTo.toString()),
            inner
        )
    )
    return toHex(redeemer.to_bytes());
}

const CLEAR_DELEGATE_REDEEMER = () => {
    const redeemer = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(
            C.BigNum.from_str(STAKE_REDEEMER_TYPE.ClearDelegate.toString()),
            C.PlutusList.new()
        )
    )
    return toHex(redeemer.to_bytes());
}

export {STAKE_DATUM, UPDATE_PURE_STAKE_DATUM, DEPOSIT_WITHDRAW_REDEEMER, DESTROY_STAKE_REDEEMER, PERMIT_VOTE_REDEEMER, RETRACT_VOTE_REDEEMER, DELEGATE_TO_REDEEMER, CLEAR_DELEGATE_REDEEMER, UPDATE_AMOUNT_STAKE_DATUM}