import {
  executeCommand,
  queryApplication,
  type AppQueryResult,
} from "../../api/bindings";
import {
  MarkdownUnavailableError,
  unavailableMarkdownFacade,
  type MarkdownFacade,
} from "./api";

function unavailableResult(): MarkdownUnavailableError {
  return new MarkdownUnavailableError();
}

export const nativeMarkdownFacade: MarkdownFacade = {
  ...unavailableMarkdownFacade,
  async listMarkdownFiles(skillId) {
    try {
      const result = await queryApplication({
        type: "list_markdown_files",
        payload: { skill_id: skillId },
      });
      if (result.type !== "markdown_files") throw unavailableResult();
      return result.payload.map((file) => ({
        label: file.label,
        path: file.path,
        primary: file.primary,
      }));
    } catch {
      throw unavailableResult();
    }
  },
  async readMarkdownFile(skillId, path) {
    try {
      const result: AppQueryResult = await queryApplication({
        type: "read_markdown_file",
        payload: { skill_id: skillId, path },
      });
      if (result.type !== "markdown_file") throw unavailableResult();
      return {
        contentIdentity: result.payload.content_identity,
        editable: result.payload.editable,
        markdown: result.payload.markdown,
        path: result.payload.path,
      };
    } catch {
      throw unavailableResult();
    }
  },
  async saveSkillContent(skillId, path, markdown, expectedIdentity) {
    const result = await executeCommand({
      type: "save_markdown_content",
      payload: {
        skill_id: skillId,
        path,
        markdown,
        expected_identity: expectedIdentity,
      },
    });
    if (result.type !== "saved_skill_content") throw unavailableResult();
    return {
      contentIdentity: result.payload.content_identity,
      newVersionId: result.payload.version_id,
    };
  },
};
