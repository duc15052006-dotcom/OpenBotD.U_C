import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents } from "../db/schema";
import {
  type AgentKnowledgeDocument,
  type AgentKnowledgeSettings,
  type AgentKnowledgeUpload,
  MAX_AGENT_KNOWLEDGE_DOCUMENTS,
  MAX_AGENT_KNOWLEDGE_DOCUMENT_CHARACTERS,
  MAX_AGENT_KNOWLEDGE_FILE_BYTES,
  MAX_AGENT_KNOWLEDGE_TOTAL_CHARACTERS,
  knowledgeSummary,
  makeAgentKnowledgeDocument,
  storedAgentKnowledgeFromOverride,
  withStoredAgentKnowledge,
} from "./knowledge";
import { canManageAgentRuntimeSettings } from "./profile-policy";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
} from "./profile-store";
import type { AgentActor } from "./profile-types";

export class AgentKnowledgeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentKnowledgeLimitError";
  }
}

export class AgentKnowledgeDocumentNotFoundError extends Error {
  constructor(public readonly documentId: string) {
    super(`Knowledge document ${documentId} was not found.`);
    this.name = "AgentKnowledgeDocumentNotFoundError";
  }
}

export type AgentKnowledgeStore = {
  list(actor: AgentActor, agentId: string): Promise<AgentKnowledgeSettings>;
  add(
    actor: AgentActor,
    agentId: string,
    upload: AgentKnowledgeUpload,
  ): Promise<AgentKnowledgeSettings>;
  remove(
    actor: AgentActor,
    agentId: string,
    documentId: string,
  ): Promise<AgentKnowledgeSettings>;
};

const limits = {
  documents: MAX_AGENT_KNOWLEDGE_DOCUMENTS,
  fileBytes: MAX_AGENT_KNOWLEDGE_FILE_BYTES,
  documentCharacters: MAX_AGENT_KNOWLEDGE_DOCUMENT_CHARACTERS,
  totalCharacters: MAX_AGENT_KNOWLEDGE_TOTAL_CHARACTERS,
};

function settings(
  documents: AgentKnowledgeDocument[],
  canManage: boolean,
): AgentKnowledgeSettings {
  return {
    documents: documents.map(knowledgeSummary),
    canManage,
    limits,
  };
}

export function createAgentKnowledgeStore(
  database: Database,
  profiles: AgentProfileStore,
): AgentKnowledgeStore {
  async function readable(actor: AgentActor, agentId: string) {
    const profile = await profiles.get(actor, agentId);
    if (!profile) throw new AgentNotFoundError(agentId);
    return profile;
  }

  async function manageable(actor: AgentActor, agentId: string) {
    const profile = await readable(actor, agentId);
    if (!canManageAgentRuntimeSettings(actor, profile)) {
      throw new AgentNotManageableError(agentId);
    }
    return profile;
  }

  async function current(agentId: string) {
    const [row] = await database
      .select({ override: agents.override })
      .from(agents)
      .where(eq(agents.id, agentId));
    if (!row) throw new AgentNotFoundError(agentId);
    return storedAgentKnowledgeFromOverride(row.override);
  }

  return {
    async list(actor, agentId) {
      const profile = await readable(actor, agentId);
      return settings(
        await current(agentId),
        canManageAgentRuntimeSettings(actor, profile),
      );
    },

    async add(actor, agentId, upload) {
      await manageable(actor, agentId);
      let saved: AgentKnowledgeDocument[] = [];

      await database.transaction(async (transaction) => {
        const [row] = await transaction
          .select({ override: agents.override })
          .from(agents)
          .where(eq(agents.id, agentId))
          .for("update");
        if (!row) throw new AgentNotFoundError(agentId);

        const documents = storedAgentKnowledgeFromOverride(row.override);
        if (documents.length >= MAX_AGENT_KNOWLEDGE_DOCUMENTS) {
          throw new AgentKnowledgeLimitError(
            `An Agent can hold at most ${MAX_AGENT_KNOWLEDGE_DOCUMENTS} knowledge files.`,
          );
        }

        const document = makeAgentKnowledgeDocument(upload);
        const totalCharacters =
          documents.reduce((sum, item) => sum + item.content.length, 0) +
          document.content.length;
        if (totalCharacters > MAX_AGENT_KNOWLEDGE_TOTAL_CHARACTERS) {
          throw new AgentKnowledgeLimitError(
            `Agent knowledge is limited to ${MAX_AGENT_KNOWLEDGE_TOTAL_CHARACTERS} characters in total.`,
          );
        }

        saved = [...documents, document];
        await transaction
          .update(agents)
          .set({
            override: withStoredAgentKnowledge(row.override, saved),
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agentId));
      });

      return settings(saved, true);
    },

    async remove(actor, agentId, documentId) {
      await manageable(actor, agentId);
      let saved: AgentKnowledgeDocument[] = [];

      await database.transaction(async (transaction) => {
        const [row] = await transaction
          .select({ override: agents.override })
          .from(agents)
          .where(eq(agents.id, agentId))
          .for("update");
        if (!row) throw new AgentNotFoundError(agentId);

        const documents = storedAgentKnowledgeFromOverride(row.override);
        saved = documents.filter((document) => document.id !== documentId);
        if (saved.length === documents.length) {
          throw new AgentKnowledgeDocumentNotFoundError(documentId);
        }

        await transaction
          .update(agents)
          .set({
            override: withStoredAgentKnowledge(row.override, saved),
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agentId));
      });

      return settings(saved, true);
    },
  };
}
