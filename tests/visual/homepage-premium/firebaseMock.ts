export const auth = {};

export const onAuthStateChanged = (_auth: unknown, callback: (user: null) => void) => {
  callback(null);
  return () => undefined;
};

export const signOut = async () => undefined;
