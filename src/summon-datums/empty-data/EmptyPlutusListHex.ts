import { C, toHex } from "lucid-cardano";

const EmptyPlutusListHex = () => {
    const data = C.PlutusData.new_list(C.PlutusList.new())
    return toHex(data.to_bytes());
}

export default EmptyPlutusListHex