import { Injectable, NotFoundException } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.types.js";
import { conflict } from "../bookings/domain-errors.js";
import { assertUnderCap, hoursAgo } from "../common/rate-cap.js";
import { authorSelect, publicName } from "../common/user-text.js";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { PROPOSALS_PER_DAY, VOTING_OPEN, type ProposalStatusName } from "./proposals.schemas.js";

/** Vote counts and the viewer's vote are added per page by `decorate()` (Prisma's `_count` would aggregate every vote on every page). */
const select = {
    id: true,
    title: true,
    description: true,
    status: true,
    responseNote: true,
    respondedAt: true,
    authorId: true,
    createdAt: true,
    author: { select: authorSelect },
} satisfies Prisma.FeatureProposalSelect;

type Base = Prisma.FeatureProposalGetPayload<{ select: typeof select }>;
type Row = Base & { _count: { votes: number }; votes: { id: string }[] };

const present = (r: Row, viewerId: string) => ({
  id: r.id,
  title: r.title,
  description: r.description,
  status: r.status,
  // Public admin response. Moderation notes (hide reasons) are never included.
  response: r.responseNote,
  respondedAt: r.respondedAt,
  author: { displayName: publicName(r.author) },
  isMine: r.authorId === viewerId,
  createdAt: r.createdAt,
  voteCount: r._count.votes,
  votedByMe: r.votes.length > 0,
  votingOpen: VOTING_OPEN.includes(r.status as ProposalStatusName),
});

@Injectable()
export class ProposalsService {
  constructor(private readonly prisma: PrismaService) {}

  private async decorate(rows: Base[], viewerId: string): Promise<Row[]> {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return [];
    const [counts, mine] = await Promise.all([
      this.prisma.featureVote.groupBy({ by: ["proposalId"], where: { proposalId: { in: ids } }, _count: { _all: true } }),
      this.prisma.featureVote.findMany({ where: { proposalId: { in: ids }, userId: viewerId }, select: { id: true, proposalId: true } }),
    ]);
    const countBy = new Map(counts.map((c) => [c.proposalId, c._count._all]));
    const mineBy = new Map(mine.map((m) => [m.proposalId, m.id]));
    return rows.map((r) => ({ ...r, _count: { votes: countBy.get(r.id) ?? 0 }, votes: mineBy.has(r.id) ? [{ id: mineBy.get(r.id)! }] : [] }));
  }

  async list(auth: AuthContext, q: { sort: "top" | "new"; status?: ProposalStatusName; page: number; pageSize: number }) {
    const where: Prisma.FeatureProposalWhereInput = { visibility: "VISIBLE", ...(q.status && { status: q.status }) };
    const orderBy: Prisma.FeatureProposalOrderByWithRelationInput[] =
      q.sort === "top"
        ? [{ votes: { _count: "desc" } }, { createdAt: "desc" }, { id: "asc" }]
        : [{ createdAt: "desc" }, { id: "asc" }];
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.featureProposal.count({ where }),
      this.prisma.featureProposal.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select }),
    ]);
    const decorated = await this.decorate(rows, auth.userId);
    return {
      proposals: decorated.map((r) => present(r, auth.userId)),
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.ceil(total / q.pageSize),
    };
  }

  private async find(auth: AuthContext, id: string) {
    const row = await this.prisma.featureProposal.findFirst({ where: { id, visibility: "VISIBLE" }, select });
    if (!row) throw new NotFoundException("Proposal not found");
    return (await this.decorate([row], auth.userId))[0]!;
  }

  async get(auth: AuthContext, id: string) {
    return { proposal: present(await this.find(auth, id), auth.userId) };
  }

  /** A proposal is created SUBMITTED; the client cannot choose a status, votes, or an author. */
  async create(auth: AuthContext, input: { title: string; description: string }) {
    assertUnderCap(
      await this.prisma.featureProposal.count({ where: { authorId: auth.userId, createdAt: { gte: hoursAgo(24) } } }),
      PROPOSALS_PER_DAY,
      "PROPOSAL_LIMIT",
      "You can submit a few proposals per day. Please try again tomorrow.",
    );
    const row = await this.prisma.featureProposal.create({ data: { authorId: auth.userId, ...input }, select: { id: true } });
    return this.get(auth, row.id);
  }

  /**
   * One vote per user per proposal: UNIQUE (proposalId, userId) + ON CONFLICT DO
   * NOTHING makes repeated and parallel requests safe and identical in effect.
   * Votes are only accepted (and withdrawn) while voting is open.
   */
  async vote(auth: AuthContext, id: string) {
    await this.assertVotingOpen(auth, id);
    await this.prisma.featureVote.createMany({ data: [{ proposalId: id, userId: auth.userId }], skipDuplicates: true });
    return { voted: true, voteCount: await this.prisma.featureVote.count({ where: { proposalId: id } }) };
  }

  async withdraw(auth: AuthContext, id: string) {
    await this.assertVotingOpen(auth, id);
    await this.prisma.featureVote.deleteMany({ where: { proposalId: id, userId: auth.userId } });
    return { voted: false, voteCount: await this.prisma.featureVote.count({ where: { proposalId: id } }) };
  }

  private async assertVotingOpen(auth: AuthContext, id: string) {
    const proposal = await this.find(auth, id);
    if (!VOTING_OPEN.includes(proposal.status as ProposalStatusName)) {
      throw conflict("VOTING_CLOSED", "Voting on this proposal has closed");
    }
  }
}
