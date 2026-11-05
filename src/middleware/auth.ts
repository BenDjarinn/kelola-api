import { fromNodeHeaders } from "better-auth/node";

import { auth } from "../lib/auth.js";

import type { NextFunction, Request, Response } from "express";

export interface AuthenticatedUser {
  email: string;
  id: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Resolves the Better Auth session and attaches the user to the request.
 *
 * Soft-deleted users are rejected here. Better Auth has no concept of deleted_at,
 * so without this check a soft-deleted account keeps a valid session and continues
 * to authenticate until that session expires.
 */
export async function requireAuth(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });

    if (!session) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { user } = session;

    if (user.deletedAt) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    request.user = {
      email: user.email,
      id: user.id,
      name: user.name,
    };

    next();
  } catch (error) {
    next(error);
  }
}
