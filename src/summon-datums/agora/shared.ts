import {Assets, assetsToValue, C, Credential, Data, DatumHash, fromHex, PaymentKeyHash, ScriptHash, toHex} from 'lucid-cardano'

const STAKE_DATUM_TYPE = {
    StakeDatum: 0
}

const P_LOCK = {
    Created: 0,
    Voted: 1
}

const MAKE_MAYBE = (data: any) => {
    if (data == undefined) {
        return C.PlutusData.new_constr_plutus_data(
            C.ConstrPlutusData.new(
                C.BigNum.from_str("1"),
                C.PlutusList.new()
            )
        )
    } else {
        const list = C.PlutusList.new()
        list.add(data)
        return C.PlutusData.new_constr_plutus_data(
            C.ConstrPlutusData.new(
                C.BigNum.from_str("0"),
                list
            )
        )
    }
}

const MAKE_CREDENTIAL = (cred: Credential) => {
    const paymentFields = C.PlutusList.new()
    paymentFields.add(
        C.PlutusData.new_bytes(fromHex(cred.hash))
    )
    let payment = MAKE_INDEXED_DATUM(0n)
    if (cred.type == "Key") {
        payment = C.PlutusData.new_constr_plutus_data(
            C.ConstrPlutusData.new(
                C.BigNum.from_str("0"),
                paymentFields
            )
        )
    } else if (cred.type == "Script") {
        payment = C.PlutusData.new_constr_plutus_data(
            C.ConstrPlutusData.new(
                C.BigNum.from_str("1"),
                paymentFields
            )
        )
    }
    if (payment == MAKE_INDEXED_DATUM(0n)) throw "The credential passed to MAKE_CREDENTIAL was invalid."
    return payment
}

const MAKE_CREDENTIAL_HEX = (cred: Credential) => {
    const c = MAKE_CREDENTIAL(cred)
    return toHex(c.to_bytes())
}

const MAKE_P_THRESHOLDS = (countVoting: BigInt, create: BigInt, startVoting: BigInt) => {
    const fieldsInner = C.PlutusList.new()
    fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(countVoting.toString())))
    fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(create.toString())))
    fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(startVoting.toString())))
    const pThreshold = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(
            C.BigNum.from_str("0"),
            fieldsInner
        )
    )
    return pThreshold;
}

const MAKE_P_LOCK = (reason: 'Created' | 'Voted', vote: BigInt, propId: BigInt) => {
    throw "MAKE_P_LOCK: Deprecated, do not use."
}

const MAKE_INDEXED_DATUM = (index: BigInt) => {
    const result = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(
            C.BigNum.from_str(index.toString()),
            C.PlutusList.new()
        )
    )
    return result;
}

const MAKE_INDEXED_DATUM_STRING = (index: BigInt) => {
    const result = C.PlutusData.new_constr_plutus_data(
        C.ConstrPlutusData.new(
            C.BigNum.from_str(index.toString()),
            C.PlutusList.new()
        )
    )
    return toHex(result.to_bytes());
}

const PROPOSAL_THRESHOLD = (
    execute : BigInt
    // -- ^ How much GT minimum must a particular 'ResultTag' accumulate for it to pass.
    , create : BigInt
    // -- ^ How much GT required to "create" a proposal.
    // -- It is recommended this be a high enough amount, in order to prevent DOS from bad
    // -- actors.
    , toVoting : BigInt
    // -- ^ How much GT required to to move into 'Locked'.
    , vote : BigInt
    // -- ^ How much GT required to vote on a outcome.
    , cosign : BigInt
    // -- ^ How much GT required to cosign a proposal.
    ) => {
        const fieldsInner = C.PlutusList.new()
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(execute.toString())))
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(create.toString())))
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(toVoting.toString())))
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(vote.toString())))
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(cosign.toString())))
        return C.PlutusData.new_list(fieldsInner)
    }

const PROPOSAL_TIMING_CONFIG = (
    draftTime: Date,
    // -- ^ "D": the length of the draft period.
    votingTime: Date,
    // -- ^ "V": the length of the voting period.
    lockingTime: Date,
    // -- ^ "L": the length of the locking period.
    executingTime: Date,
    // -- ^ "E": the length of the execution period.
    minStakeVotingTime: Date,
    // -- ^ Minimum time from creating a voting lock until it can be destroyed.
    votingTimeRangeMaxWidth: Date
    // -- ^ The maximum width of transaction time range while voting.
    ) => {
        const newTimings : [Date, Date, Date, Date, Date, Date]= [new Date(draftTime), new Date(votingTime), new Date(lockingTime), new Date(executingTime), new Date(minStakeVotingTime), new Date(votingTimeRangeMaxWidth)]
        if (newTimings[5].valueOf() < 600000) throw "The voting time range max width must be at least 10 minutes."
        const fieldsInner = C.PlutusList.new()
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(newTimings[0].valueOf().toString())))
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(newTimings[1].valueOf().toString())))
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(newTimings[2].valueOf().toString())))
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(newTimings[3].valueOf().toString())))
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(newTimings[4].valueOf().toString())))
        fieldsInner.add(C.PlutusData.new_integer(C.BigInt.from_str(newTimings[5].valueOf().toString())))
        return C.PlutusData.new_list(fieldsInner)
    }

function fromAssets(assets: Assets): Map<string, Map<string, bigint>> {
    const value = new Map<string, Map<string, bigint>>();
    if (assets.lovelace) value.set("", new Map([["", assets.lovelace]]));
      
    const units = Object.keys(assets);
    const policies = Array.from(
        new Set(
        units
            .filter((unit) => unit !== "lovelace")
            .map((unit) => unit.slice(0, 56)),
        ),
    );
    policies.sort().forEach((policyId) => {
        const policyUnits = units.filter((unit) => unit.slice(0, 56) === policyId);
        const assetsMap = new Map<string, bigint>();
        policyUnits.sort().forEach((unit) => {
        assetsMap.set(
            unit.slice(56),
            assets[unit],
        );
        });
        value.set(policyId, assetsMap);
    });
    return value;
}
      

const MAKE_ASSET = (asset: Assets) => {
    const valueTs: Map<string, Map<string, bigint>> = fromAssets(asset)
    const value = C.PlutusMap.new()
    for (const policy of valueTs.keys()) {
        const assets = valueTs.get(policy)
        if (!assets) throw new Error("Invalid asset policy present.")
        const assetMap = C.PlutusMap.new()
        for (const asset of assets.keys()) {
            let assetName = C.PlutusData.new_bytes(fromHex(asset))
            let amount = C.PlutusData.new_integer(C.BigInt.from_str((assets.get(asset) || 0n).toString()))
            assetMap.insert(assetName, amount)
        }
        value.insert(C.PlutusData.new_bytes(fromHex(policy)), C.PlutusData.new_map(assetMap))
    }
    return C.PlutusData.new_map(value)
}

const MAKE_TREASURY_WITHDRAWAL = (receivers: [arg0: Credential, arg1: Assets][], treasuries: Credential[]) => {
    const pairs = C.PlutusMap.new()
    const pairsl = C.PlutusList.new()
    const ts = C.PlutusList.new()
    for (const [cred, assets] of receivers) {
        let l = C.PlutusList.new()
        l.add(MAKE_CREDENTIAL(cred))
        l.add(MAKE_ASSET(assets))
        pairs.insert(MAKE_CREDENTIAL(cred), MAKE_ASSET(assets))
        pairsl.add(C.PlutusData.new_constr_plutus_data(C.ConstrPlutusData.new(C.BigNum.from_str("0"), l)))
    }
    for (const treasury of treasuries) {
        ts.add(MAKE_CREDENTIAL(treasury))
    }
    const fieldsInner = C.PlutusList.new()
    fieldsInner.add(C.PlutusData.new_list(pairsl))
    fieldsInner.add(C.PlutusData.new_list(ts))
    return fieldsInner
}

export {MAKE_MAYBE, MAKE_P_THRESHOLDS, MAKE_P_LOCK, MAKE_INDEXED_DATUM_STRING, MAKE_INDEXED_DATUM, MAKE_CREDENTIAL, MAKE_CREDENTIAL_HEX, MAKE_TREASURY_WITHDRAWAL, PROPOSAL_TIMING_CONFIG, PROPOSAL_THRESHOLD, P_LOCK, STAKE_DATUM_TYPE}