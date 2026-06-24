import { init, captureException } from "@inariwatch/capture"

init({ environment: "test" })

try {
  throw new Error("test error from esbuild")
} catch (err) {
  captureException(err)
}

console.log("ESBUILD_OK")
