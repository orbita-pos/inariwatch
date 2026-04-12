import { init, captureException } from "@inariwatch/capture"

init({ environment: "test" })

try {
  throw new Error("test error from rollup")
} catch (err) {
  captureException(err)
}

console.log("ROLLUP_OK")
