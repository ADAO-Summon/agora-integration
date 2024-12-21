import dotenv from 'dotenv'
dotenv.config()
const SERVICES = process.env.ENVIRONMENT === 'production' ? {
  AUTH_SERVICE: "http://0.0.0.0:8080",
  USER_SERVICE: "http://0.0.0.0:8089",
  DATA_SERVICE: "http://0.0.0.0:8090",
  ESCROW_SERVICE: "http://0.0.0.0:8069",
  APIKEYS_SERVICE: "http://0.0.0.0:8032",

} as const : {
  USER_SERVICE: "https://testnetapi.summonplatform.io/v1/users", // "http://127.0.0.1:8089",//"https://testnetapi.summonplatform.io/v1/users",
  DATA_SERVICE: "https://testnetapi.summonplatform.io/v1/data",
  AUTH_SERVICE: "https://testnetapi.summonplatform.io/v1/auth",
  ESCROW_SERVICE: "https://testnetapi.summonplatform.io/v1/payment",// "http://45.76.255.87:8069"
  APIKEYS_SERVICE: "http://0.0.0.0:8032",
} as const

export { SERVICES}