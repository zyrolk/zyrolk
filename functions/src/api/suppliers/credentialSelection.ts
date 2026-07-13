export interface A2ZCredentialPair {
  username: string;
  password: string;
}

export interface A2ZCredentialCandidate extends A2ZCredentialPair {
  source: string;
}

export interface ResolvedA2ZCredentials extends A2ZCredentialPair {
  source: string;
}

function isComplete(candidate: A2ZCredentialCandidate): boolean {
  return Boolean(candidate.username && candidate.password);
}

export function resolveA2ZCredentials(
  runtimeSecrets: A2ZCredentialPair,
  legacyCandidates: A2ZCredentialCandidate[],
): ResolvedA2ZCredentials | null {
  const runtimeCandidate = { ...runtimeSecrets, source: "secret-manager" };

  if (isComplete(runtimeCandidate)) {
    return runtimeCandidate;
  }

  return legacyCandidates.find(isComplete) || null;
}
