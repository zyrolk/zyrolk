import React, { useState } from 'react';
import { X, LogIn, Mail, Lock, User, AlertCircle } from 'lucide-react';
import { auth, db } from '../firebase';
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  GoogleAuthProvider, 
  signInWithPopup,
  updateProfile
} from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { getAuthErrorMessage } from '../features/auth/authErrorMessage';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function AuthModal({ isOpen, onClose }: AuthModalProps) {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const normalizedEmail = email.trim().toLowerCase();
    const cleanDisplayName = displayName.trim();

    if (isSignUp) {
      if (password.length < 6) {
        setError("Security Rule: Password must be at least 6 characters long.");
        setLoading(false);
        return;
      }
    }

    try {
      if (isSignUp) {
        // Create user
        const credential = await createUserWithEmailAndPassword(auth, normalizedEmail, password);
        const name = cleanDisplayName || normalizedEmail.split('@')[0];
        await updateProfile(credential.user, { displayName: name });
        
        // Save user profile in Firestore
        await setDoc(doc(db, "users", credential.user.uid), {
          uid: credential.user.uid,
          email: credential.user.email,
          displayName: name,
          role: 'customer',
          createdAt: new Date().toISOString()
        });
      } else {
        // Sign in
        await signInWithEmailAndPassword(auth, normalizedEmail, password);
      }
      onClose();
    } catch (err: unknown) {
      console.error(err);
      setError(getAuthErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setError("");
    setLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      // Use popup for sign in
      const result = await signInWithPopup(auth, provider);
      const user = result.user;

      // Save user profile in Firestore
      await setDoc(doc(db, "users", user.uid), {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || user.email?.split('@')[0],
        role: 'customer',
        createdAt: new Date().toISOString()
      }, { merge: true });

      onClose();
    } catch (err: unknown) {
      console.warn("Google popup sign-in failed:", err);
      setError(getAuthErrorMessage(err));

    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      
      {/* Modal Stage */}
      <div
        className="relative w-full max-w-md bg-white rounded-3xl overflow-hidden shadow-2xl border border-slate-100 p-6 md:p-8 animate-fadeIn text-left"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        aria-describedby="auth-modal-description"
      >
        
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 flex h-11 w-11 items-center justify-center text-slate-500 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-full transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
          aria-label="Close sign in dialog"
        >
          <X className="h-4.5 w-4.5" aria-hidden="true" />
        </button>

        {/* Brand */}
        <div className="text-center space-y-2 mb-6 flex flex-col items-center justify-center">
          <div className="relative mb-2 flex h-12 min-w-32 items-center justify-center" role="img" aria-label="Zyro.lk">
            <span className="text-2xl font-black font-display text-slate-900" aria-hidden="true">Zyro<span className="text-brand-blue">.lk</span></span>
            <img
              src="/logo.png"
              alt=""
              className="absolute inset-0 h-12 w-full bg-white object-contain"
              referrerPolicy="no-referrer"
              onError={(event) => { event.currentTarget.hidden = true; }}
            />
          </div>
          <h2 id="auth-modal-title" className="text-xl font-bold font-display text-slate-800">
            {isSignUp ? "Create Premium Account" : "Welcome Back"}
          </h2>
          <p id="auth-modal-description" className="text-xs text-slate-500 font-light">
            {isSignUp ? "Register to save wishlists and explore genuine items." : "Sign in to access your electronics panel."}
          </p>
        </div>

        {/* Error notification */}
        {error && (
          <div className="bg-red-50 border border-red-100 text-red-700 text-xs p-3 rounded-2xl flex items-start space-x-2 mb-5" role="alert">
            <AlertCircle className="h-4.5 w-4.5 text-red-500 shrink-0 mt-0.5" aria-hidden="true" />
            <p className="font-light">{error}</p>
          </div>
        )}

        {/* Standard Email Auth Form */}
        <form onSubmit={handleEmailAuth} className="space-y-4">
          
          {isSignUp && (
            <div>
              <label htmlFor="auth-display-name" className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Full Name</label>
              <div className="relative">
                <input
                  id="auth-display-name"
                  type="text"
                  required
                  placeholder="Amara Wijesinghe"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="min-h-11 w-full text-sm pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus-visible:outline-none focus-visible:border-brand-blue focus-visible:ring-4 focus-visible:ring-brand-blue/15"
                />
                <User className="pointer-events-none absolute left-3.5 top-3 h-4.5 w-4.5 text-slate-500" aria-hidden="true" />
              </div>
            </div>
          )}

          <div>
            <label htmlFor="auth-email" className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Email Address</label>
            <div className="relative">
              <input
                id="auth-email"
                type="email"
                required
                placeholder="amara@gmail.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="min-h-11 w-full text-sm pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus-visible:outline-none focus-visible:border-brand-blue focus-visible:ring-4 focus-visible:ring-brand-blue/15"
              />
              <Mail className="pointer-events-none absolute left-3.5 top-3 h-4.5 w-4.5 text-slate-500" aria-hidden="true" />
            </div>
          </div>

          <div>
            <label htmlFor="auth-password" className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Password</label>
            <div className="relative">
              <input
                id="auth-password"
                type="password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="min-h-11 w-full text-sm pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus-visible:outline-none focus-visible:border-brand-blue focus-visible:ring-4 focus-visible:ring-brand-blue/15"
              />
              <Lock className="pointer-events-none absolute left-3.5 top-3 h-4.5 w-4.5 text-slate-500" aria-hidden="true" />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full min-h-11 px-4 py-3 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-sm font-semibold transition-all cursor-pointer flex items-center justify-center shadow-xs focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-slate-900/25 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-70"
            aria-busy={loading}
          >
            <LogIn className="h-4 w-4 mr-1.5" aria-hidden="true" />
            {loading ? "Authenticating..." : isSignUp ? "Create Account" : "Sign In"}
          </button>

        </form>

        {/* Divider */}
        <div className="relative my-6 text-center">
          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-100"></div></div>
          <span className="relative bg-white px-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider">or connect via</span>
        </div>

        {/* Social Authentication */}
        <button
          onClick={handleGoogleLogin}
          className="w-full min-h-11 px-4 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-all flex items-center justify-center space-x-2 cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/15"
        >
          <svg className="h-4 w-4 mr-2" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
          </svg>
          <span>Continue with Google</span>
        </button>

        {/* Toggle signup */}
        <div className="mt-6 text-center text-xs text-slate-500">
          {isSignUp ? "Already have a Zyro account?" : "New to Zyro.lk?"}{" "}
          <button
            onClick={() => setIsSignUp(!isSignUp)}
            className="inline-flex min-h-11 items-center rounded-lg px-2 font-semibold text-brand-blue hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/15"
          >
            {isSignUp ? "Sign In" : "Register Now"}
          </button>
        </div>

      </div>
    </div>
  );
}
