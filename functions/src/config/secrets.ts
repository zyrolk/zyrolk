import { defineSecret } from "firebase-functions/params";

export const A2Z_USERNAME_SECRET = defineSecret("A2Z_USERNAME");
export const A2Z_PASSWORD_SECRET = defineSecret("A2Z_PASSWORD");
export const DROPEX_USERNAME_SECRET = defineSecret("DROPEX_USERNAME");
export const DROPEX_PASSWORD_SECRET = defineSecret("DROPEX_PASSWORD");
export const A2Z_SECRETS = [A2Z_USERNAME_SECRET, A2Z_PASSWORD_SECRET];
export const DROPEX_SECRETS = [DROPEX_USERNAME_SECRET, DROPEX_PASSWORD_SECRET];
/** PayHere remains in source for a future rollout, but is not bound to Functions while COD-only mode is active. */
export const API_SECRETS = [...A2Z_SECRETS, ...DROPEX_SECRETS];

export function getA2ZSecretValues(): { username: string; password: string } {
  return {
    username: A2Z_USERNAME_SECRET.value() || "",
    password: A2Z_PASSWORD_SECRET.value() || "",
  };
}

export function getDropexSecretValues(): { username: string; password: string } {
  return {
    username: DROPEX_USERNAME_SECRET.value() || "",
    password: DROPEX_PASSWORD_SECRET.value() || "",
  };
}
