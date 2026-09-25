import { PrismaClient, Role, AssetStatus, Prisma } from '@prisma/client';
import { AppError } from '../utils/AppError';

const prisma = new PrismaClient();

export interface AssetFilters {
  type?: string;
  status?: string;
  search?: string;
  assignedToId?: string;
}

export interface CreateAssetInput {
  assetTag?: string;
  name: string;
  type: string;
  model: string;
  serialNumber: string;
  status?: AssetStatus;
  assignedToId?: string | null;
  locationId?: string | null;
}

export interface UpdateAssetInput {
  assetTag?: string;
  name?: string;
  type?: string;
  model?: string;
  serialNumber?: string;
  status?: AssetStatus;
  assignedToId?: string | null;
  locationId?: string | null;
}

export async function generateAssetTag(): Promise<string> {
  const latest = await prisma.asset.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { assetTag: true },
  });

  let nextNum = 1;
  if (latest && latest.assetTag.startsWith('AST')) {
    const numPart = parseInt(latest.assetTag.replace('AST', ''), 10);
    if (!isNaN(numPart)) {
      nextNum = numPart + 1;
    }
  }

  return `AST${String(nextNum).padStart(6, '0')}`;
}

export async function listAssets(filters: AssetFilters = {}) {
  const where: Prisma.AssetWhereInput = {};

  if (filters.status && filters.status !== 'ALL') {
    where.status = filters.status as AssetStatus;
  }

  if (filters.type && filters.type !== 'ALL') {
    where.type = filters.type;
  }

  if (filters.assignedToId) {
    where.assignedToId = filters.assignedToId;
  }

  if (filters.search && filters.search.trim()) {
    const term = filters.search.trim();
    where.OR = [
      { assetTag: { contains: term, mode: 'insensitive' } },
      { name: { contains: term, mode: 'insensitive' } },
      { model: { contains: term, mode: 'insensitive' } },
      { serialNumber: { contains: term, mode: 'insensitive' } },
      { locationId: { contains: term, mode: 'insensitive' } },
    ];
  }

  return prisma.asset.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      assignedTo: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      _count: {
        select: { incidents: true },
      },
    },
  });
}

export async function getAssetById(id: string) {
  const asset = await prisma.asset.findUnique({
    where: { id },
    include: {
      assignedTo: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      incidents: {
        select: {
          id: true,
          ticketNumber: true,
          shortDescription: true,
          status: true,
          priority: true,
          createdAt: true,
          requester: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!asset) {
    throw new AppError('Asset not found', 404);
  }

  return asset;
}

export async function createAsset(
  data: CreateAssetInput,
  user: { userId: string; role: Role }
) {
  if (user.role === Role.User) {
    throw new AppError('Forbidden. Only technicians and admins can register assets.', 403);
  }

  if (!data.name || !data.type || !data.model || !data.serialNumber) {
    throw new AppError('Asset name, type, model, and serial number are required.', 400);
  }

  const assetTag = data.assetTag?.trim() || (await generateAssetTag());

  // Check unique assetTag
  const existing = await prisma.asset.findUnique({ where: { assetTag } });
  if (existing) {
    throw new AppError(`Asset with tag ${assetTag} already exists.`, 400);
  }

  const status = data.status ?? (data.assignedToId ? AssetStatus.ASSIGNED : AssetStatus.AVAILABLE);

  return prisma.asset.create({
    data: {
      assetTag,
      name: data.name.trim(),
      type: data.type.trim(),
      model: data.model.trim(),
      serialNumber: data.serialNumber.trim(),
      status,
      assignedToId: data.assignedToId || null,
      locationId: data.locationId?.trim() || null,
    },
    include: {
      assignedTo: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });
}

export async function updateAsset(
  id: string,
  data: UpdateAssetInput,
  user: { userId: string; role: Role }
) {
  if (user.role === Role.User) {
    throw new AppError('Forbidden. Only technicians and admins can update assets.', 403);
  }

  const existing = await prisma.asset.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Asset not found', 404);
  }

  const updateData: Prisma.AssetUpdateInput = {};
  if (data.name !== undefined) updateData.name = data.name.trim();
  if (data.type !== undefined) updateData.type = data.type.trim();
  if (data.model !== undefined) updateData.model = data.model.trim();
  if (data.serialNumber !== undefined) updateData.serialNumber = data.serialNumber.trim();
  if (data.locationId !== undefined) updateData.locationId = data.locationId?.trim() || null;
  if (data.status !== undefined) updateData.status = data.status;

  if (data.assignedToId !== undefined) {
    if (data.assignedToId === null || data.assignedToId === '') {
      updateData.assignedTo = { disconnect: true };
      if (!data.status && existing.status === AssetStatus.ASSIGNED) {
        updateData.status = AssetStatus.AVAILABLE;
      }
    } else {
      updateData.assignedTo = { connect: { id: data.assignedToId } };
      if (!data.status && existing.status === AssetStatus.AVAILABLE) {
        updateData.status = AssetStatus.ASSIGNED;
      }
    }
  }

  return prisma.asset.update({
    where: { id },
    data: updateData,
    include: {
      assignedTo: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
      incidents: true,
    },
  });
}
