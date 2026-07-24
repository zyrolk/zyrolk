import { defineSecret } from "firebase-functions/params";

export const A2Z_USERNAME_SECRET = defineSecret("A2Z_USERNAME");
export const A2Z_PASSWORD_SECRET = defineSecret("A2Z_PASSWORD");
export const A2Z_SECRETS = [A2Z_USERNAME_SECRET, A2Z_PASSWORD_SECRET];
/** PayHere remains in source for a future rollout, but is not bound to Functions while COD-only mode is active. */
export const API_SECRETS = [...A2Z_SECRETS];

export function getA2ZSecretValues(): { username: string; password: string } {
  return {
    username: A2Z_USERNAME_SECRET.value() || "",
    password: A2Z_PASSWORD_SECRET.value() || "",
  };
}
