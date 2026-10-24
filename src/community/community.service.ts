import { Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { conflict } from "../bookings/domain-errors.js";
import { assertUnderCap, hoursAgo } from "../common/rate-cap.js";
import { authorSelect, excerpt, publicName } from "../common/user-text.js";
import type { ReactionType } from "../generated/prisma/enums.js";
import { PrismaService } from "../prisma/prisma.service.js";

/** Rolling-hour creation caps per user (counts include the user's deleted items). */
export const POSTS_PER_HOUR = 10;
export const COMMENTS_PER_HOUR = 30;

/**
 * Counts are NOT selected with Prisma's `_count`: it compiles to a join against
 * a GROUP BY over the whole reactions / comments tables, so every page costs a
 * full scan (measured ~100 ms at 100k reactions + 150k comments, independent of
 * page size). `decorate()` counts only the ids on the page instead.
 */
const postSelect = {
  id: true,
  title: true,
  body: true,
  status: true,
  authorId: true,
  createdAt: true,
  editedAt: true,
  author: { select: authorSelect },
} as const;

type PostRow = Awaited<ReturnType<PrismaService["communityPost"]["findFirstOrThrow"]>> & {
  author: { name: string; customerProfile: { displayName: string } | null };
  _count: { reactions: number; comments: number };
  reactions: { id: string }[];
};

@Injectable()
export class CommunityService {
  constructor(private readonly prisma: PrismaService) {}

  /** Adds like/comment counts and the viewer's own like for the posts on one page (three queries bounded by the page's ids). */
  private async decorate<T extends { id: string }>(rows: T[], viewerId: string): Promise<(T & Pick<PostRow, "_count" | "reactions">)[]> {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return [];
    const [likes, comments, mine] = await Promise.all([
      this.prisma.postReaction.groupBy({ by: ["postId"], where: { postId: { in: ids } }, _count: { _all: true } }),
      this.prisma.postComment.groupBy({ by: ["postId"], where: { postId: { in: ids }, status: "VISIBLE" }, _count: { _all: true } }),
      this.prisma.postReaction.findMany({ where: { postId: { in: ids }, userId: viewerId }, select: { id: true, postId: true } }),
    ]);
    const likeBy = new Map(likes.map((l) => [l.postId, l._count._all]));
    const commentBy = new Map(comments.map((c) => [c.postId, c._count._all]));
    const mineBy = new Map(mine.map((m) => [m.postId, m.id]));
    return rows.map((r) => ({
      ...r,
      _count: { reactions: likeBy.get(r.id) ?? 0, comments: commentBy.get(r.id) ?? 0 },
      reactions: mineBy.has(r.id) ? [{ id: mineBy.get(r.id)! }] : [],
    }));
  }

  /** A post as the viewer may see it. `status` is HIDDEN only for the author's own removed post. */
  private presentPost(row: PostRow, viewerId: string, full: boolean) {
    const text = full ? { body: row.body, truncated: false } : (() => {
      const e = excerpt(row.body);
      return { body: e.text, truncated: e.truncated };
    })();
    return {
      id: row.id,
      title: row.title,
      ...text,
      status: row.status,
      author: { displayName: publicName(row.author) },
      isMine: row.authorId === viewerId,
      createdAt: row.createdAt,
      editedAt: row.editedAt,
      likeCount: row._count.reactions,
      commentCount: row._count.comments,
      likedByMe: row.reactions.length > 0,
    };
  }

  async listPosts(auth: AuthContext, scope: "all" | "mine", page: number, pageSize: number) {
    // "mine" also shows the author's own moderator-hidden posts (flagged by status) so removals are explained.
    const where =
      scope === "mine"
        ? { authorId: auth.userId, status: { in: ["VISIBLE", "HIDDEN"] as ("VISIBLE" | "HIDDEN")[] } }
        : { status: "VISIBLE" as const };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.communityPost.count({ where }),
      this.prisma.communityPost.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: postSelect,
      }),
    ]);
    const decorated = await this.decorate(rows, auth.userId);
    return {
      posts: (decorated as unknown as PostRow[]).map((r) => this.presentPost(r, auth.userId, false)),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  private async findPost(auth: AuthContext, id: string): Promise<PostRow> {
    const row = await this.prisma.communityPost.findFirst({
      where: { id, OR: [{ status: "VISIBLE" }, { status: "HIDDEN", authorId: auth.userId }] },
      select: postSelect,
    });
    if (!row) throw new NotFoundException("Post not found");
    return (await this.decorate([row], auth.userId))[0] as unknown as PostRow;
  }

  async getPost(auth: AuthContext, id: string) {
    return { post: this.presentPost(await this.findPost(auth, id), auth.userId, true) };
  }

  async createPost(auth: AuthContext, input: { title: string; body: string }) {
    assertUnderCap(
      await this.prisma.communityPost.count({ where: { authorId: auth.userId, createdAt: { gte: hoursAgo(1) } } }),
      POSTS_PER_HOUR,
      "POST_LIMIT",
      "You are posting too quickly. Please wait a while.",
    );
    const row = await this.prisma.communityPost.create({ data: { authorId: auth.userId, ...input }, select: { id: true } });
    return this.getPost(auth, row.id);
  }

  /** Author only, only while the post is VISIBLE (moderator-hidden posts cannot be edited back into view). */
  async updatePost(auth: AuthContext, id: string, input: { title?: string; body?: string }) {
    const { count } = await this.prisma.communityPost.updateMany({
      where: { id, authorId: auth.userId, status: "VISIBLE" },
      data: { ...input, editedAt: new Date() },
    });
    if (count === 0) await this.explainNoWrite("post", id, auth.userId);
    return this.getPost(auth, id);
  }

  /** Author only. Soft delete (final); idempotent. */
  async deletePost(auth: AuthContext, id: string) {
    const post = await this.prisma.communityPost.findFirst({ where: { id, authorId: auth.userId }, select: { status: true } });
    if (!post) throw new NotFoundException("Post not found");
    if (post.status === "HIDDEN") throw conflict("CONTENT_UNDER_MODERATION", "This post is under moderation and cannot be changed");
    await this.prisma.communityPost.updateMany({ where: { id, authorId: auth.userId, status: "VISIBLE" }, data: { status: "DELETED" } });
    return { deleted: true };
  }

  /** Why a guarded write touched nothing: missing/not yours -> 404, moderated -> 409. */
  private async explainNoWrite(kind: "post" | "comment", id: string, userId: string): Promise<never> {
    const row =
      kind === "post"
        ? await this.prisma.communityPost.findFirst({ where: { id, authorId: userId }, select: { status: true } })
        : await this.prisma.postComment.findFirst({ where: { id, authorId: userId }, select: { status: true } });
    if (row?.status === "HIDDEN") throw conflict("CONTENT_UNDER_MODERATION", "This content is under moderation and cannot be changed");
    throw new NotFoundException(kind === "post" ? "Post not found" : "Comment not found");
  }

  // ------------------------------------------------------------------ comments

  private async visiblePost(id: string) {
    const post = await this.prisma.communityPost.findFirst({ where: { id, status: "VISIBLE" }, select: { id: true } });
    if (!post) throw new NotFoundException("Post not found");
  }

  private presentComment(
    c: { id: string; body: string; authorId: string; createdAt: Date; editedAt: Date | null; author: { name: string; customerProfile: { displayName: string } | null } },
    viewerId: string,
  ) {
    return {
      id: c.id,
      body: c.body,
      author: { displayName: publicName(c.author) },
      isMine: c.authorId === viewerId,
      createdAt: c.createdAt,
      editedAt: c.editedAt,
    };
  }

  async listComments(auth: AuthContext, postId: string, page: number, pageSize: number) {
    await this.visiblePost(postId);
    const where = { postId, status: "VISIBLE" as const };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.postComment.count({ where }),
      this.prisma.postComment.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, body: true, authorId: true, createdAt: true, editedAt: true, author: { select: authorSelect } },
      }),
    ]);
    return {
      comments: rows.map((c) => this.presentComment(c, auth.userId)),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async createComment(auth: AuthContext, postId: string, body: string) {
    await this.visiblePost(postId);
    assertUnderCap(
      await this.prisma.postComment.count({ where: { authorId: auth.userId, createdAt: { gte: hoursAgo(1) } } }),
      COMMENTS_PER_HOUR,
      "COMMENT_LIMIT",
      "You are commenting too quickly. Please wait a while.",
    );
    const row = await this.prisma.postComment.create({
      data: { postId, authorId: auth.userId, body },
      select: { id: true, body: true, authorId: true, createdAt: true, editedAt: true, author: { select: authorSelect } },
    });
    return { comment: this.presentComment(row, auth.userId) };
  }

  async updateComment(auth: AuthContext, id: string, body: string) {
    const { count } = await this.prisma.postComment.updateMany({
      where: { id, authorId: auth.userId, status: "VISIBLE", post: { status: "VISIBLE" } },
      data: { body, editedAt: new Date() },
    });
    if (count === 0) await this.explainNoWrite("comment", id, auth.userId);
    const row = await this.prisma.postComment.findUniqueOrThrow({
      where: { id },
      select: { id: true, body: true, authorId: true, createdAt: true, editedAt: true, author: { select: authorSelect } },
    });
    return { comment: this.presentComment(row, auth.userId) };
  }

  async deleteComment(auth: AuthContext, id: string) {
    const row = await this.prisma.postComment.findFirst({ where: { id, authorId: auth.userId }, select: { status: true } });
    if (!row) throw new NotFoundException("Comment not found");
    if (row.status === "HIDDEN") throw conflict("CONTENT_UNDER_MODERATION", "This comment is under moderation and cannot be changed");
    await this.prisma.postComment.updateMany({ where: { id, authorId: auth.userId, status: "VISIBLE" }, data: { status: "DELETED" } });
    return { deleted: true };
  }

  // ------------------------------------------------------------------ reactions

  private async likeCount(postId: string, type: ReactionType) {
    return this.prisma.postReaction.count({ where: { postId, type } });
  }

  /**
   * Idempotent. UNIQUE (post, user, type) + INSERT ... ON CONFLICT DO NOTHING:
   * repeated or parallel requests leave exactly one row and the same answer.
   * Counts are always read from stored rows.
   */
  async react(auth: AuthContext, postId: string, type: ReactionType) {
    await this.visiblePost(postId);
    await this.prisma.postReaction.createMany({ data: [{ postId, userId: auth.userId, type }], skipDuplicates: true });
    return { reacted: true, likeCount: await this.likeCount(postId, type) };
  }

  async unreact(auth: AuthContext, postId: string, type: ReactionType) {
    await this.visiblePost(postId);
    await this.prisma.postReaction.deleteMany({ where: { postId, userId: auth.userId, type } });
    return { reacted: false, likeCount: await this.likeCount(postId, type) };
  }
}
