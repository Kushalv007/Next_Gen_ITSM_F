import { PrismaClient, Role, ArticleStatus, Prisma } from '@prisma/client';
import { AppError } from '../utils/AppError';

const prisma = new PrismaClient();

export interface ArticleFilters {
  category?: string;
  search?: string;
  status?: string;
}

export interface CreateArticleInput {
  title: string;
  content: string;
  category: string;
  status?: ArticleStatus;
}

export interface UpdateArticleInput {
  title?: string;
  content?: string;
  category?: string;
  status?: ArticleStatus;
}

export async function listArticles(
  filters: ArticleFilters = {},
  user?: { userId: string; role: Role }
) {
  const where: Prisma.KnowledgeArticleWhereInput = {};

  // Employees can only view PUBLISHED articles
  if (!user || user.role === Role.User) {
    where.status = ArticleStatus.PUBLISHED;
  } else if (filters.status && filters.status !== 'ALL') {
    where.status = filters.status as ArticleStatus;
  }

  if (filters.category && filters.category !== 'ALL') {
    where.category = filters.category;
  }

  if (filters.search && filters.search.trim()) {
    const term = filters.search.trim();
    where.OR = [
      { title: { contains: term, mode: 'insensitive' } },
      { content: { contains: term, mode: 'insensitive' } },
      { category: { contains: term, mode: 'insensitive' } },
    ];
  }

  return prisma.knowledgeArticle.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    include: {
      author: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });
}

export async function getArticleById(id: string, user?: { userId: string; role: Role }) {
  const article = await prisma.knowledgeArticle.findUnique({
    where: { id },
    include: {
      author: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });

  if (!article) {
    throw new AppError('Knowledge article not found', 404);
  }

  // If draft, only agents and admins can view
  if (article.status === ArticleStatus.DRAFT && (!user || user.role === Role.User)) {
    throw new AppError('Forbidden. You do not have access to view draft articles.', 403);
  }

  return article;
}

export async function createArticle(
  data: CreateArticleInput,
  authorId: string,
  user: { userId: string; role: Role }
) {
  // Only Agents and Admins can author articles
  if (user.role === Role.User) {
    throw new AppError('Forbidden. Only agents and admins can create knowledge articles.', 403);
  }

  if (!data.title || !data.content || !data.category) {
    throw new AppError('Title, content, and category are required.', 400);
  }

  return prisma.knowledgeArticle.create({
    data: {
      title: data.title.trim(),
      content: data.content.trim(),
      category: data.category.trim(),
      status: data.status ?? ArticleStatus.DRAFT,
      authorId,
    },
    include: {
      author: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });
}

export async function updateArticle(
  id: string,
  data: UpdateArticleInput,
  user: { userId: string; role: Role }
) {
  // Only Agents and Admins can update articles
  if (user.role === Role.User) {
    throw new AppError('Forbidden. Only agents and admins can update knowledge articles.', 403);
  }

  const existing = await prisma.knowledgeArticle.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Knowledge article not found', 404);
  }

  const updateData: Prisma.KnowledgeArticleUpdateInput = {};
  if (data.title) updateData.title = data.title.trim();
  if (data.content) updateData.content = data.content.trim();
  if (data.category) updateData.category = data.category.trim();
  if (data.status) updateData.status = data.status;

  return prisma.knowledgeArticle.update({
    where: { id },
    data: updateData,
    include: {
      author: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });
}

export async function deleteArticle(id: string, user: { userId: string; role: Role }) {
  // Only Admin can delete articles
  if (user.role !== Role.Admin) {
    throw new AppError('Forbidden. Only administrators can delete knowledge articles.', 403);
  }

  const existing = await prisma.knowledgeArticle.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Knowledge article not found', 404);
  }

  await prisma.knowledgeArticle.delete({ where: { id } });
  return { success: true, message: 'Article deleted successfully' };
}

export async function suggestArticlesByKeywords(queryText: string) {
  if (!queryText || !queryText.trim()) return [];

  const stopwords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'have', 'from',
    'they', 'what', 'when', 'where', 'which', 'who', 'how', 'why',
    'are', 'was', 'were', 'not', 'can', 'cant', 'cannot', 'will',
    'wont', 'does', 'doesnt', 'about', 'some', 'any', 'into', 'just', 'been'
  ]);

  const keywords = queryText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopwords.has(w));

  if (keywords.length === 0) {
    return [];
  }

  const whereOrConditions: Prisma.KnowledgeArticleWhereInput[] = keywords.flatMap((kw) => [
    { title: { contains: kw, mode: 'insensitive' } },
    { content: { contains: kw, mode: 'insensitive' } },
    { category: { contains: kw, mode: 'insensitive' } },
  ]);

  return prisma.knowledgeArticle.findMany({
    where: {
      status: ArticleStatus.PUBLISHED,
      OR: whereOrConditions,
    },
    take: 5,
    orderBy: { updatedAt: 'desc' },
    include: {
      author: {
        select: { id: true, firstName: true, lastName: true, email: true, role: true },
      },
    },
  });
}

