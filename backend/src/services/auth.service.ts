import { prisma } from '../config/prisma';
import { config } from '../config/environment';
import { AppError } from '../utils/AppError';
import { hashPassword, comparePassword } from '../utils/password';
import {
  generateTokenPair,
  signAccessToken,
  signRefreshToken,
  verifyToken,
  TokenPayload,
  parseExpiresIn,
} from '../utils/jwt';
import { RegisterInput, LoginInput } from '../validations/auth.validation';
import { User, Role } from '@prisma/client';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface UserWithoutPassword {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

const excludePassword = (user: User): UserWithoutPassword => {
  const { password: _password, ...rest } = user;
  return rest;
};

export const createUser = async (
  input: RegisterInput
): Promise<{ user: UserWithoutPassword; tokens: AuthTokens }> => {
  const existingUser = await prisma.user.findUnique({
    where: { email: input.email.toLowerCase() },
  });

  if (existingUser) {
    throw new AppError('Email is already registered.', 409);
  }

  const hashedPassword = await hashPassword(input.password);

  const user = await prisma.user.create({
    data: {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email.toLowerCase(),
      password: hashedPassword,
      role: Role.User,  
    },
  });

  const tokenPayload: TokenPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
  };

  const tokens = generateTokenPair(tokenPayload);

  const refreshExpiresAt = parseExpiresIn(config.JWT_REFRESH_EXPIRES_IN);

  await prisma.refreshToken.create({
    data: {
      token: tokens.refreshToken,
      userId: user.id,
      expiresAt: refreshExpiresAt,
    },
  });

  return {
    user: excludePassword(user),
    tokens,
  };
};

export const findUserByEmail = async (email: string): Promise<User | null> => {
  return prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });
};

export const verifyUserCredentials = async (
  input: LoginInput
): Promise<User> => {
  const user = await findUserByEmail(input.email);

  if (!user) {
    throw new AppError('Invalid email or password.', 401);
  }

  const isPasswordValid = await comparePassword(input.password, user.password);

  if (!isPasswordValid) {
    throw new AppError('Invalid email or password.', 401);
  }

  return user;
};

export const createSession = async (
  user: User
): Promise<{ user: UserWithoutPassword; tokens: AuthTokens }> => {
  await prisma.refreshToken.deleteMany({
    where: { userId: user.id },
  });

  const tokenPayload: TokenPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
  };

  const tokens = generateTokenPair(tokenPayload);

  const refreshExpiresAt = parseExpiresIn(config.JWT_REFRESH_EXPIRES_IN);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    }),
    prisma.refreshToken.create({
      data: {
        token: tokens.refreshToken,
        userId: user.id,
        expiresAt: refreshExpiresAt,
      },
    }),
  ]);

  return {
    user: excludePassword(user),
    tokens,
  };
};

export const revokeRefreshToken = async (
  refreshToken: string,
  userId?: string
): Promise<void> => {
  const tokenRecord = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
  });

  if (!tokenRecord) {
    throw new AppError('Refresh token not found.', 404);
  }

  if (userId && tokenRecord.userId !== userId) {
    throw new AppError('Unauthorized to revoke this token.', 403);
  }

  await prisma.refreshToken.delete({
    where: { token: refreshToken },
  });
};

export const refreshAccessToken = async (
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string }> => {
  const tokenRecord = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
  });

  if (!tokenRecord) {
    throw new AppError('Invalid refresh token.', 401);
  }

  if (tokenRecord.revokedAt) {
    throw new AppError('Refresh token has been revoked.', 401);
  }

  if (new Date() > tokenRecord.expiresAt) {
    await prisma.refreshToken.delete({ where: { token: refreshToken } });
    throw new AppError('Refresh token has expired.', 401);
  }

  let payload: TokenPayload;
  try {
    payload = verifyToken<TokenPayload>(refreshToken, config.JWT_REFRESH_SECRET);
  } catch {
    await prisma.refreshToken.delete({ where: { token: refreshToken } });
    throw new AppError('Invalid refresh token.', 401);
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
  });

  if (!user) {
    throw new AppError('User no longer exists.', 401);
  }

  const tokenPayload: TokenPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
  };

  const accessToken = signAccessToken(tokenPayload);
  const newRefreshToken = signRefreshToken(tokenPayload);
  const refreshExpiresAt = parseExpiresIn(config.JWT_REFRESH_EXPIRES_IN);

  await prisma.$transaction([
    prisma.refreshToken.delete({ where: { token: refreshToken } }),
    prisma.refreshToken.create({
      data: {
        token: newRefreshToken,
        userId: user.id,
        expiresAt: refreshExpiresAt,
      },
    }),
  ]);

  return {
    accessToken,
    refreshToken: newRefreshToken,
  };
};

export const getUserById = async (
  userId: string
): Promise<UserWithoutPassword> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new AppError('User not found.', 404);
  }

  return excludePassword(user);
};
