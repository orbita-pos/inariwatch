import { init, captureException } from "@inariwatch/capture"

init({ environment: "test" })

try {
  throw new Error("test error from node-esm")
} catch (err) {
  captureException(err)
}

console.log("NODE_ESM_OK")
