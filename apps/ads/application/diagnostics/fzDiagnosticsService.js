"use strict";

const { RULES_VERSION, evaluateFzRules } = require("./fzRulesEngine");

const VALID_STATUSES = new Set(["open", "acknowledged", "dismissed", "resolved"]);

class FzDiagnosticsService {
  constructor({ repository, multichannelService, multichannelRepository, workspaceRepository }) {
    this.repository = repository;
    this.multichannelService = multichannelService;
    this.multichannelRepository = multichannelRepository;
    this.workspaceRepository = workspaceRepository;
  }

  async list(identity, input = {}) {
    const workspace = await this.workspaceRepository.ensureDefaultWorkspace(identity);
    const findings = await this.repository.listFindings(identity.tenantId, workspace.id, {
      includeResolved: String(input.includeResolved || "false") === "true",
    });
    return { workspace, rulesVersion: RULES_VERSION, findings };
  }

  async run(identity, input = {}) {
    const context = await this.multichannelService.getContext(identity, { range: input.range });
    const workspace = context.workspace || await this.workspaceRepository.ensureDefaultWorkspace(identity);
    const runId = await this.repository.createRun(identity.tenantId, workspace.id, context.rangeDays || 30, RULES_VERSION);
    try {
      let zeroTerms = [];
      if (context.available && context.period && context.channels?.google_ads) {
        zeroTerms = await this.multichannelRepository.getGoogleZeroConversionSearchTerms(
          identity.tenantId,
          workspace.id,
          context.period.startDate,
          context.period.endDate,
          10,
        );
      }
      const findings = evaluateFzRules(context, { googleZeroConversionSearchTerms: zeroTerms });
      await this.repository.upsertFindings(identity.tenantId, workspace.id, runId, findings);
      // Missing data is not evidence that an older problem was resolved. Only close
      // stale findings after a complete, comparable evaluation window exists.
      if (context.available) {
        await this.repository.resolveMissing(identity.tenantId, workspace.id, findings.map((item) => item.fingerprint));
      }
      await this.repository.completeRun(identity.tenantId, runId, findings.length);
      const stored = await this.repository.listFindings(identity.tenantId, workspace.id, { includeResolved: false });
      return { runId, rulesVersion: RULES_VERSION, context, findings: stored };
    } catch (error) {
      await this.repository.failRun(identity.tenantId, runId, error.message).catch(() => {});
      throw error;
    }
  }

  async setStatus(identity, findingId, status) {
    if (!VALID_STATUSES.has(status)) {
      const error = new Error("Finding status is invalid");
      error.code = "FZ_FINDING_STATUS_INVALID";
      throw error;
    }
    const workspace = await this.workspaceRepository.ensureDefaultWorkspace(identity);
    const result = await this.repository.updateStatus(identity.tenantId, workspace.id, String(findingId), status);
    if (!result) {
      const error = new Error("FZ finding not found");
      error.code = "FZ_FINDING_NOT_FOUND";
      throw error;
    }
    return result;
  }
}

module.exports = { FzDiagnosticsService };
