import type { AuthUser } from '@hostelcode/shared';
import { getCollaboratorColor } from '@hostelcode/shared';

const STORAGE_KEY_USER = 'hostelcode_current_user';
const STORAGE_KEY_ACCOUNTS = 'hostelcode_registered_accounts';

export interface StoredAccount {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  color: string;
  createdAt: string;
}

// In-browser password hashing for client-side persistence
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(16);
}

export function getCurrentUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USER);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setCurrentUser(user: AuthUser | null): void {
  if (user) {
    localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));
  } else {
    localStorage.removeItem(STORAGE_KEY_USER);
  }
}

export function getRegisteredAccounts(): StoredAccount[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ACCOUNTS);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function registerUser(name: string, email: string, password: string): Promise<AuthUser> {
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name.trim();

  if (!cleanName || !cleanEmail || !password) {
    throw new Error('Name, email, and password are all required.');
  }

  const accounts = getRegisteredAccounts();
  if (accounts.some((acc) => acc.email === cleanEmail)) {
    throw new Error('An account with this email already exists. Please sign in instead.');
  }

  const user: AuthUser = {
    id: `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    name: cleanName,
    email: cleanEmail,
    color: getCollaboratorColor(cleanEmail),
  };

  const newAccount: StoredAccount = {
    ...user,
    passwordHash: simpleHash(password),
    createdAt: new Date().toISOString(),
  };

  accounts.push(newAccount);
  localStorage.setItem(STORAGE_KEY_ACCOUNTS, JSON.stringify(accounts));
  setCurrentUser(user);

  return user;
}

export async function loginUser(email: string, password: string): Promise<AuthUser> {
  const cleanEmail = email.trim().toLowerCase();
  const accounts = getRegisteredAccounts();
  const account = accounts.find((acc) => acc.email === cleanEmail);

  if (!account) {
    throw new Error('No account found with this email. Please register first.');
  }

  if (account.passwordHash !== simpleHash(password)) {
    throw new Error('Incorrect password. Please verify your password and try again.');
  }

  const user: AuthUser = {
    id: account.id,
    name: account.name,
    email: account.email,
    color: account.color,
  };

  setCurrentUser(user);
  return user;
}

export function logoutUser(): void {
  setCurrentUser(null);
}
