import { init, captureException } from "@inariwatch/capture"

init({ environment: "test" })

try {
  throw new Error("test error from webpack")
} catch (err) {
  captureException(err)
}

console.log("WEBPACK_OK")
