import { defineSecret } from "firebase-functions/params";

export const A2Z_USERNAME_SECRET = defineSecret("A2Z_USERNAME");
export const A2Z_PASSWORD_SECRET = defineSecret("A2Z_PASSWORD");
export const PAYHERE_MERCHANT_SECRET = defineSecret("PAYHERE_MERCHANT_SECRET");

export const A2Z_SECRETS = [A2Z_USERNAME_SECRET, A2Z_PASSWORD_SECRET];
export const API_SECRETS = [...A2Z_SECRETS, PAYHERE_MERCHANT_SECRET];

export function getA2ZSecretValues(): { username: string; password: string } {
  return {
    username: A2Z_USERNAME_SECRET.value() || process.env.A2Z_USERNAME || "",
    password: A2Z_PASSWORD_SECRET.value() || process.env.A2Z_PASSWORD || "",
  };
}
