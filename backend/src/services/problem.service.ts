import { PrismaClient, Role, ProblemStatus, Prisma } from '@prisma/client';
import { AppError } from '../utils/AppError';

const prisma = new PrismaClient();

export interface ProblemFilters {
  status?: string;
  search?: string;
  ownerId?: string;
}

export interface CreateProblemInput {
  title: string;
  description: string;
  ownerId?: string;
  rootCause?: string;
  workaround?: string;
}

export interface UpdateProblemInput {
  title?: string;
  description?: string;
  status?: ProblemStatus;
  ownerId?: string | null;
  rootCause?: string;
  workaround?: string;
}

export async function generateProblemNumber(): Promise<string> {
  const latest = await prisma.problem.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { problemNumber: true },
  });

  let nextNum = 1;
  if (latest && latest.problemNumber.startsWith('PRB')) {
    const numPart = parseInt(latest.problemNumber.replace('PRB', ''), 10);
    if (!isNaN(numPart)) {
      nextNum = numPart + 1;
    }
  }

  return `PRB${String(nextNum).padStart(6, '0')}`;
}

export async function listProblems(filters: ProblemFilters = {}) {
  const where: Prisma.ProblemWhereInput = {};

  if (filters.status && filters.status !== 'ALL') {
    where.status = filters.status as ProblemStatus;
  }

  if (filters.ownerId) {
    where.ownerId = filters.ownerId;
  }

  if (filters.search && filters.search.trim()) {
    const term = filters.search.trim();
    where.OR = [
      { problemNumber: { contains: term, mode: 'insensitive' } },
      { title: { contains: term, mode: 'insensitive' } },
      { description: { contains: term, mode: 'insensitive' } },
      { rootCause: { contains: term, mode: 'insensitive' } },
    ];
  }

  return prisma.problem.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      owner: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      _count: {
        select: { incidents: true },
      },
    },
  });
}

export async function getProblemById(id: string) {
  const problem = await prisma.problem.findUnique({
    where: { id },
    include: {
      owner: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      incidents: {
        select: {
          id: true,
          ticketNumber: true,
          shortDescription: true,
          status: true,
          priority: true,
          category: true,
          createdAt: true,
          requester: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      },
    },
  });

  if (!problem) {
    throw new AppError('Problem not found', 404);
  }

  return problem;
}

export async function createProblem(
  data: CreateProblemInput,
  user: { userId: string; role: Role }
) {
  if (user.role === Role.User) {
    throw new AppError('Forbidden. Only agents and admins can manage problems.', 403);
  }

  if (!data.title || !data.description) {
    throw new AppError('Title and description are required.', 400);
  }

  const problemNumber = await generateProblemNumber();

  return prisma.problem.create({
    data: {
      problemNumber,
      title: data.title.trim(),
      description: data.description.trim(),
      rootCause: data.rootCause?.trim() || null,
      workaround: data.workaround?.trim() || null,
      ownerId: data.ownerId || user.userId,
      status: ProblemStatus.OPEN,
    },
    include: {
      owner: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      incidents: true,
    },
  });
}

export async function updateProblem(
  id: string,
  data: UpdateProblemInput,
  user: { userId: string; role: Role }
) {
  if (user.role === Role.User) {
    throw new AppError('Forbidden. Only agents and admins can update problems.', 403);
  }

  const existing = await prisma.problem.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Problem not found', 404);
  }

  const updateData: Prisma.ProblemUpdateInput = {};
  if (data.title !== undefined) updateData.title = data.title.trim();
  if (data.description !== undefined) updateData.description = data.description.trim();
  if (data.status !== undefined) updateData.status = data.status;
  if (data.rootCause !== undefined) updateData.rootCause = data.rootCause?.trim() || null;
  if (data.workaround !== undefined) updateData.workaround = data.workaround?.trim() || null;

  if (data.ownerId !== undefined) {
    if (data.ownerId === null || data.ownerId === '') {
      updateData.owner = { disconnect: true };
    } else {
      updateData.owner = { connect: { id: data.ownerId } };
    }
  }

  return prisma.problem.update({
    where: { id },
    data: updateData,
    include: {
      owner: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      incidents: true,
    },
  });
}

export async function linkIncidentToProblem(
  problemId: string,
  incidentId: string,
  user: { userId: string; role: Role }
) {
  if (user.role === Role.User) {
    throw new AppError('Forbidden. Only agents and admins can link incidents.', 403);
  }

  const problem = await prisma.problem.findUnique({ where: { id: problemId } });
  if (!problem) throw new AppError('Problem not found', 404);

  const incident = await prisma.incident.findUnique({ where: { id: incidentId } });
  if (!incident) throw new AppError('Incident not found', 404);

  return prisma.incident.update({
    where: { id: incidentId },
    data: { problemId },
    include: {
      problem: true,
    },
  });
}

export async function unlinkIncidentFromProblem(
  problemId: string,
  incidentId: string,
  user: { userId: string; role: Role }
) {
  if (user.role === Role.User) {
    throw new AppError('Forbidden. Only agents and admins can unlink incidents.', 403);
  }

  return prisma.incident.update({
    where: { id: incidentId },
    data: { problemId: null },
  });
}
