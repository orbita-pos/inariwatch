import * as LocalAuth from "expo-local-authentication";
import AsyncStorage from "@react-native-async-storage/async-storage";

const BIOMETRIC_KEY = "inari_biometric_enabled";

export async function isBiometricAvailable(): Promise<boolean> {
  try {
    const compatible = await LocalAuth.hasHardwareAsync();
    if (!compatible) return false;
    const enrolled = await LocalAuth.isEnrolledAsync();
    return enrolled;
  } catch {
    return false;
  }
}

export async function isBiometricEnabled(): Promise<boolean> {
  const val = await AsyncStorage.getItem(BIOMETRIC_KEY);
  return val === "true";
}

export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(BIOMETRIC_KEY, enabled ? "true" : "false");
}

export async function authenticateBiometric(): Promise<boolean> {
  try {
    const result = await LocalAuth.authenticateAsync({
      promptMessage: "Desbloquear InariWatch",
      cancelLabel: "Cancelar",
      fallbackLabel: "Usar contraseña",
      disableDeviceFallback: false,
    });
    return result.success;
  } catch {
    return false;
  }
}
