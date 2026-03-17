import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import GitLabProvider from "next-auth/providers/gitlab";
import bcrypt from "bcryptjs";
import * as OTPAuth from "otpauth";
import { db, users } from "@/lib/db";
import { eq } from "drizzle-orm";

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },

  providers: [
    GitHubProvider({
      clientId:     process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),

    // Google OAuth (optional — only enabled if env vars are set)
    ...(process.env.GOOGLE_CLIENT_ID
      ? [
          GoogleProvider({
            clientId:     process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          }),
        ]
      : []),

    // GitLab OAuth (optional — only enabled if env vars are set)
    ...(process.env.GITLAB_CLIENT_ID
      ? [
          GitLabProvider({
            clientId:     process.env.GITLAB_CLIENT_ID,
            clientSecret: process.env.GITLAB_CLIENT_SECRET!,
          }),
        ]
      : []),

    CredentialsProvider({
      name: "credentials",
      credentials: {
        email:    { label: "Email",    type: "email" },
        password: { label: "Password", type: "password" },
        totp:     { label: "2FA Code", type: "text" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, credentials.email))
          .limit(1);

        if (!user || !user.passwordHash) return null;

        const valid = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!valid) return null;

        // Check 2FA if enabled
        if (user.twoFactorEnabled && user.totpSecret) {
          const totpCode = credentials.totp;
          if (!totpCode) {
            throw new Error("2FA_REQUIRED");
          }

          const totp = new OTPAuth.TOTP({
            issuer: "InariWatch",
            label: user.email,
            algorithm: "SHA1",
            digits: 6,
            period: 30,
            secret: OTPAuth.Secret.fromBase32(user.totpSecret),
          });

          const delta = totp.validate({ token: totpCode, window: 1 });
          if (delta === null) {
            throw new Error("INVALID_2FA");
          }
        }

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],

  callbacks: {
    // Called on every sign-in (OAuth or credentials).
    // For OAuth: upsert the user in our DB so we have a real UUID.
    async jwt({ token, account, profile }) {
      if (account) {
        // First sign-in — look up or create the user in our DB
        const email = token.email;
        if (!email) return token;

        let [dbUser] = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        if (!dbUser) {
          const [inserted] = await db
            .insert(users)
            .values({
              email,
              name: token.name ?? null,
            })
            .returning();
          dbUser = inserted;
        }

        // Store OUR UUID (not GitHub's numeric id) in the token
        token.id = dbUser.id;
      }

      return token;
    },

    async session({ session, token }) {
      if (session.user) {
        (session.user as { id?: string }).id = token.id as string;
      }
      return session;
    },

    async redirect({ url, baseUrl }) {
      // Respect callbackUrl if it's on the same origin
      if (url.startsWith(baseUrl)) return url;
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      // Default: go to dashboard
      return `${baseUrl}/dashboard`;
    },
  },

  pages: {
    signIn: "/login",
  },
};
