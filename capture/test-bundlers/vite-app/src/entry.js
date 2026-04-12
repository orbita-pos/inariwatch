import { init, captureException } from "@inariwatch/capture"

init({ environment: "test" })

try {
  throw new Error("test error from vite")
} catch (err) {
  captureException(err)
}

console.log("VITE_OK")
