import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, appendFileSync, unlinkSync, rmdirSync } from "fs";
import { execSync, execFile, execFileSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import yaml from "js-yaml";

// ─── Subagent Response Suppression ───────────────────
const spawnedSessionKeys = new Set();
const yamlParse = (str) => {
    try {
        return yaml.load(str) || { version: "0.0.0", gates: [] };
    }
    catch {
        return { version: "0.0.0", gates: [] };
    }
};
// ─── State Store ─────────────────────────────────────
const STATE_DIR = join(homedir(), ".openclaw", "state"); // legacy backup dir
const USE_STATE_LOCK = true; // P2: global toggle for state lock (false → lock-free)
const STATE_LOCK = join(STATE_DIR, "harness-state.lock");
const CONTRACTS_DIR = join(homedir(), ".openclaw", "workspace", "contracts"); // user-specified contract files only
const SPECS_DIR = join(homedir(), ".openclaw", "workspace", "projects", "agent-team-orchestration", "shared", "specs");
const STATE_FILE = join(SPECS_DIR, "harness-state.json"); // CT-01: persistent state file
const TRANSITIONS_LOG = join(SPECS_DIR, "harness-transitions.log"); // CT-02: structured transition log
/**
 * withStateLock — mkdir 原子锁 + 30s 超时 + stale 检测
 * 保护 saveState 的写操作不被并发覆盖
 */
function withStateLock(fn) {
    const deadline = Date.now() + 30000;
    // 50ms sync sleep via Atomics.wait — allocate the wait buffer once instead of
    // on every 50ms spin (SharedArrayBuffer alloc is comparatively expensive).
    // Buffer stays zeroed, so Atomics.wait(buf,0,0,50) still times out each spin.
    const waitBuf = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < deadline) {
        try {
            mkdirSync(STATE_LOCK);
            break;
        }
        catch {
            try {
                if (existsSync(STATE_LOCK) && Date.now() - statSync(STATE_LOCK).mtimeMs > 30000) {
                    rmdirSync(STATE_LOCK);
                }
            }
            catch { }
        }
        Atomics.wait(waitBuf, 0, 0, 50);
    }
    if (Date.now() >= deadline) {
        console.warn(`[harness-hooks] withStateLock: 30s timeout, degrading to lock-free`);
        return fn();
    }
    try {
        return fn();
    }
    finally {
        try {
            rmdirSync(STATE_LOCK);
        }
        catch { }
    }
}
// ─── Sub-agent Config ────────────────────────────────
const CONFIG_FILE = join(homedir(), ".openclaw", "workspace", "projects", "agent-team-orchestration", "shared", "config", "subagents.json");
let _cachedConfig = null;
function loadConfig() {
    if (_cachedConfig)
        return _cachedConfig;
    try {
        const raw = readFileSync(CONFIG_FILE, "utf-8");
        _cachedConfig = JSON.parse(raw);
        console.log(`[harness-hooks] config loaded: ${_cachedConfig.agents ? Object.keys(_cachedConfig.agents).length : 0} agent types`);
        return _cachedConfig;
    }
    catch (e) {
        console.warn(`[harness-hooks] config load FAILED: ${e.message}, using hardcoded fallback`);
        _cachedConfig = null;
        return null;
    }
}
function invalidateConfigCache() { _cachedConfig = null; }
function getModelTiers() {
    const cfg = loadConfig();
    return cfg?.model?.tiers || MODEL_TIERS_FALLBACK;
}
function getModelDeadPatterns() {
    const cfg = loadConfig();
    if (cfg?.model?.deadPatterns) {
        return cfg.model.deadPatterns.map(p => new RegExp(p, "i"));
    }
    return MODEL_DEAD_PATTERNS_FALLBACK;
}
function getComplexTaskKeywords() {
    const cfg = loadConfig();
    return cfg?.model?.escalation?.complexTaskKeywords || COMPLEX_TASK_KEYWORDS_FALLBACK;
}
function getAgentConfig(type) {
    const cfg = loadConfig();
    return cfg?.agents?.[type] || null;
}
function getGlobalConfig() {
    const cfg = loadConfig();
    return cfg?.global || {};
}
function fallbackSubAgentStates() {
    return {
        coder: { handoffDone: false, handoffAt: null, spawnedAt: null, doneAt: null },
        spec_reviewer: { spawnedAt: null, doneAt: null, passedAt: null, failedAt: null },
        quality_reviewer: { spawnedAt: null, doneAt: null, passedAt: null, failedAt: null },
        reviewer: { handoffDone: false, handoffAt: null, spawnedAt: null, doneAt: null },
        planner: { handoffDone: false, handoffAt: null, spawnedAt: null, doneAt: null },
        verify: { passedAt: null, failedAt: null, result: null },
    };
}
function getDefaultSubAgentStates() {
    const cfg = loadConfig();
    return cfg?.states?.defaultSchema || fallbackSubAgentStates();
}
// ─── Failure Arbiter ────────────────────────────────
const ARBITER_SCRIPT = join(homedir(), ".openclaw", "workspace", "scripts", "failure_arbiter.py");
const USE_ASYNC_ARBITER = true; // async preferred; false = sync fallback
function callArbiter(stage, reportText, contractPath, ct) {
    try {
        // Write report to temp file for arbiter
        const tmpDir = join(homedir(), ".openclaw", "tmp");
        mkdirSync(tmpDir, { recursive: true });
        const tmpFile = join(tmpDir, `arbiter-report-${ct || stage}-${Date.now()}.txt`);
        writeFileSync(tmpFile, reportText, "utf-8");
        const args = [`--stage`, stage, `--report`, tmpFile];
        if (contractPath)
            args.push(`--contract`, contractPath);
        if (ct)
            args.push(`--ct`, ct);
        const result = execSync(`python3 ${ARBITER_SCRIPT} ${args.join(" ")}`, {
            encoding: "utf-8",
            timeout: 15000,
        });
        return JSON.parse(result);
    }
    catch (e) {
        console.log(`[harness-hooks] callArbiter: error=${e.message}, fallback to Noise`);
        return {
            classification: "Noise",
            confidence: 0,
            reasoning: `Arbiter crash: ${e.message}. Fallback to Noise (retry).`,
            action: "retry",
            auto: true,
            arbiter_error: true,
        };
    }
}
/**
 * callArbiterAsync — Promise version of callArbiter, uses execFile (no shell)
 * Same return structure as sync callArbiter
 */
function callArbiterAsync(stage, reportText, contractPath, ct) {
    return new Promise((resolve) => {
        try {
            const tmpDir = join(homedir(), ".openclaw", "tmp");
            mkdirSync(tmpDir, { recursive: true });
            const tmpFile = join(tmpDir, `arbiter-report-${ct || stage}-${Date.now()}.txt`);
            writeFileSync(tmpFile, reportText, "utf-8");
            const args = [ARBITER_SCRIPT, "--stage", stage, "--report", tmpFile];
            if (contractPath)
                args.push("--contract", contractPath);
            if (ct)
                args.push("--ct", ct);
            execFile("python3", args, { timeout: 15000, encoding: "utf-8" }, (err, stdout) => {
                if (err) {
                    console.log(`[harness-hooks] callArbiterAsync: error=${err.message}, fallback to Noise`);
                    resolve({
                        classification: "Noise",
                        confidence: 0,
                        reasoning: `Arbiter crash: ${err.message}. Fallback to Noise (retry).`,
                        action: "retry",
                        auto: true,
                        arbiter_error: true,
                    });
                }
                else {
                    resolve(JSON.parse(stdout));
                }
            });
        }
        catch (e) {
            console.log(`[harness-hooks] callArbiterAsync: error=${e.message}, fallback to Noise`);
            resolve({
                classification: "Noise",
                confidence: 0,
                reasoning: `Arbiter crash: ${e.message}. Fallback to Noise (retry).`,
                action: "retry",
                auto: true,
                arbiter_error: true,
            });
        }
    });
}
const LC_EXTENSIONS = [".yaml", ".yml", ".md"];
const LOG_ROTATE_THRESHOLD_BYTES = 500 * 1024;
// ─── Model Fallback Tiers (fallback if config missing) ──
const MODEL_TIERS_FALLBACK = [
    { key: "glm", label: "ZAI/GLM" },
    { key: "gpt-codex", label: "GPT 5.5 Codex" },
    { key: "deepseek", label: "DeepSeek" },
    { key: "deepseek-pro", label: "DeepSeek Pro" },
];
const MODEL_DEAD_PATTERNS_FALLBACK = [
    /error\s*:\s*(timeout|deadline|no\s+response)/i,
    /(model|llm|ai)\s+(unavailable|not\s+responding|busy|overloaded)/i,
    /rate\s*limit|quota\s*exceeded/i,
    /empty\s+response|no\s+output|returned\s+empty/i,
    /ECONNREFUSED|ETIMEDOUT|ECONNRESET/i,
    /502|503|504|429/i,
];
const COMPLEX_TASK_KEYWORDS_FALLBACK = [
    "architecture", "design", "refactor", "complex", "large",
    "deep", "analyze", "strategy", "optimize", "scalable",
    "distributed", "system design", "performance",
];
// ═══════════════════════════════════════════════════════
// CT-01: Intent Parser — 结构化意图解析
// ═══════════════════════════════════════════════════════
// Intent route definitions with priority ordering (higher = matched first)
const INTENT_ROUTES = [
    {
        intent_type: "draft_contract",
        target: "lc-drafter",
        priority: 4,
        primary: [/起草.*?合约/, /开.*?合约/, /拆.*?合约/, /出.*?合约/, /写.*?合约/,
            /细化.*?合约/, /contract\s+for/i, /LC\s+for/i, /new\s+contract/i,
            /起草\s*LC/i, /draft\s+LC/i, /新合约/, /给.*?合约/, /拆.*?LC/i],
        secondary: [/合约/i, /contract/i, /LC/i],
        stateMatch: ["INACTIVE", "LC_ACTIVE"],
    },
    {
        intent_type: "execute_ct",
        target: "to-prd",
        priority: 3,
        primary: [/prd/i, /写PRD/i, /出PRD/i, /需求文档/i, /产品需求/i,
            /product.*requirement/i, /需求规格/i],
        secondary: [/需求/i, /requirement/i],
        stateMatch: ["INACTIVE", "LC_ACTIVE", "CT_RUNNING"],
    },
    {
        intent_type: "review",
        target: "write-a-skill",
        priority: 2,
        primary: [/创建技能/i, /写.*?(skill|技能)/i, /写技能/i, /新建.*?skill/i, /新建.*?技能/i,
            /create.*?skill/i, /write.*?skill/i, /开发.*技能/i, /制作.*skill/i,
            /新的skill/i, /新技能/i, /创建.*?skill/i],
        secondary: [/skill/i, /技能/i],
        stateMatch: ["INACTIVE", "LC_ACTIVE", "CT_RUNNING"],
    },
    {
        intent_type: "auto_spawn",
        target: "auto-spawn",
        priority: 1,
        primary: [/执行.*?任务/i, /运行.*?测试/i, /构建.*?项目/i, /build.*?task/i,
            /implement.*?feature/i, /code.*?task/i, /开发.*?功能/i, /实现.*?需求/i,
            /评审.*?代码/i, /审查.*?产出/i, /检查.*?质量/i, /review.*?code/i,
            /audit.*?result/i, /build.*?test/i,
            /test.*?feature/i, /代码.*?质量/i, /代码审查/i],
        secondary: [/任务.*?(分解|执行|排期)/i, /测试.*?(用例|方案|覆盖|报告)/i, /task.*?(breakdown|execution)/i, /test.*?(plan|case|suite|coverage)/i, /review.*?(code|result|output)/i, /代码.*?质量/i, /检查.*?质量/i, /审查.*?(产出|代码|结果|报告)/i],
        stateMatch: ["SPEC_REVIEW", "QUALITY_REVIEW", "INTEGRATION_VERIFY", "ARBITER_BLOCKED"],
    },
    // ═══ CT-02: 3 new intents ═══
    {
        intent_type: "memory_query",
        target: "memory_query",
        priority: 3,
        primary: [/记住|记录|save.*memory|store.*memory|写入.*记忆|回忆|回想|还记得|recall/i, /memory.*(query|search|get|recall)/i,
            /记不.*|忘.*了|查.*记忆|找.*记忆/],
        secondary: [/memory/i, /记忆/i, /remember/i, /recall/i],
        stateMatch: ["INACTIVE", "LC_ACTIVE", "CT_RUNNING", "SPEC_REVIEW", "QUALITY_REVIEW", "INTEGRATION_VERIFY", "ARBITER_BLOCKED"],
    },
    {
        intent_type: "knowledge_query",
        target: "knowledge_query",
        priority: 3,
        primary: [/查资料|查.*知识|找.*文档|搜索.*(https?|技术|资料|信息|内容)/, /search.*(web|internet|google|baidu)/i,
            /what is|how does.*work|define|explain.*concept|wiki|wikipedia/i],
        secondary: [/查.*(资料|文档|知识|信息)/i, /搜索/i, /search.*(web|internet|doc)/i, /find.*(info|doc|reference)/i, /look.?up/i, /知识/i, /教程/i, /文档/i, /doc/i],
        stateMatch: ["INACTIVE", "LC_ACTIVE", "CT_RUNNING", "SPEC_REVIEW", "QUALITY_REVIEW", "INTEGRATION_VERIFY", "ARBITER_BLOCKED"],
    },
    {
        intent_type: "system_maintenance",
        target: "system_maintenance",
        priority: 5,
        primary: [/gateway|plugin|config.*schema|openclaw\.json|load\.paths/, /restart|start.*plugin|stop.*plugin|add.*plugin|remove.*plugin/,
            /更新.*plugin|部署.*gateway|npx.*openclaw|openclaw.*(config|restart|stop|start)/i],
        secondary: [/维护.*(系统|gateway|插件)/i, /maintenance/i, /system.*(update|config|maintenance)/i, /update.*(plugin|gateway|system)/i, /升级.*(系统|插件|gateway)/i, /配置.*(系统|插件|gateway|schema)/i, /config.*(schema|update|plugin|gateway)/i],
        stateMatch: ["INACTIVE", "LC_ACTIVE", "CT_RUNNING", "SPEC_REVIEW", "QUALITY_REVIEW", "INTEGRATION_VERIFY", "ARBITER_BLOCKED"],
    },
];
/**
 * intentParser(userPrompt) — CT-01 核心函数
 * 输出 {intent_type, target, confidence, matchedKeyword}
 * confidence: 主关键词+0.5, 次关键词+0.2, state匹配+0.2
 * confidence < 0.7 → 不走 intent route
 */
function intentParser(userPrompt, currentState) {
    const text = (typeof userPrompt === "string") ? userPrompt : JSON.stringify(userPrompt);
    const state = currentState || "INACTIVE";
    let bestMatch = null;
    let bestScore = 0;
    for (const route of INTENT_ROUTES) {
        let score = 0;
        let matchedKeyword = null;
        // Primary keyword match (+0.5)
        for (const pat of route.primary) {
            const m = text.match(pat);
            if (m) {
                score += 0.5;
                matchedKeyword = m[0];
                break; // only count once
            }
        }
        // Secondary keyword match (+0.2)
        for (const pat of route.secondary) {
            const m = text.match(pat);
            if (m) {
                score += 0.2;
                if (!matchedKeyword)
                    matchedKeyword = m[0];
                break;
            }
        }
        // State match (+0.2)
        if (route.stateMatch.includes(state)) {
            score += 0.2;
        }
        if (score > bestScore) {
            bestScore = score;
            bestMatch = route;
            bestMatch._matchedKeyword = matchedKeyword;
        }
    }
    // Confidence threshold: < 0.7 → unknown
    if (bestScore < 0.7 || !bestMatch) {
        return { intent_type: "unknown", target: null, confidence: bestScore, matchedKeyword: null };
    }
    // Determine sub_intent based on matched secondary keywords
    let sub_intent = null;
    if (bestMatch && bestMatch.intent_type === "memory_query") {
        const lowerText = text.toLowerCase();
        if (/记住|记录|save|store|写入/.test(lowerText))
            sub_intent = "save";
        else if (/回忆|回想|还记得|recall|query|search|查.*记忆/.test(lowerText))
            sub_intent = "retrieve";
        else
            sub_intent = "general";
    }
    else if (bestMatch && bestMatch.intent_type === "knowledge_query") {
        const lowerText = text.toLowerCase();
        if (/https?:|url|link|网站|article|page/.test(lowerText))
            sub_intent = "web_fetch";
        else if (/搜索|search|google|baidu|查.*资料/.test(lowerText))
            sub_intent = "web_search";
        else
            sub_intent = "concept";
    }
    else if (bestMatch && bestMatch.intent_type === "system_maintenance") {
        const lowerText = text.toLowerCase();
        if (/gateway/.test(lowerText))
            sub_intent = "gateway";
        else if (/plugin/.test(lowerText))
            sub_intent = "plugin";
        else if (/config|openclaw\.json|schema/.test(lowerText))
            sub_intent = "config";
        else
            sub_intent = "general";
    }
    return {
        intent_type: bestMatch.intent_type,
        target: bestMatch.target,
        confidence: Math.min(bestScore, 1.0),
        matchedKeyword: bestMatch._matchedKeyword,
        sub_intent: sub_intent,
    };
}
// ═══════════════════════════════════════════════════════
// CT-02: Action Gate — 行为校验 + Audit Log
// ═══════════════════════════════════════════════════════
// Expected tool sets per intent route
const INTENT_TOOL_SETS = {
    "lc-drafter": {
        expected: ["write", "read", "exec", "sessions_spawn", "sessions_send"],
        description: "write/read/exec (合约起草)",
    },
    "to-prd": {
        expected: ["write", "read", "exec", "web_search", "web_fetch"],
        description: "write/read/exec (PRD撰写)",
    },
    "write-a-skill": {
        expected: ["write", "read", "exec", "edit"],
        description: "write/read/exec/edit (技能创建)",
    },
    "auto-spawn": {
        expected: ["sessions_spawn", "sessions_send", "sessions_yield", "write", "read", "exec"],
        description: "sessions_spawn/send (子agent管理)",
    },
    // ═══ CT-02: New intent tool sets ═══
    "memory_query": {
        expected: ["memory_get", "memory_search", "write", "read"],
        description: "memory_get/memory_search (记忆操作)",
    },
    "knowledge_query": {
        expected: ["web_search", "web_fetch", "read", "memory_search"],
        description: "web_search/web_fetch (知识检索)",
    },
    "system_maintenance": {
        expected: ["exec", "read", "write"],
        description: "exec (系统维护)",
    },
};
// Track consecutive blocks per session
const actionGateBlocks = new Map();
function checkActionGate(intent, toolName, sessionId) {
    if (!intent || intent.intent_type === "unknown" || !intent.target)
        return null;
    const toolSet = INTENT_TOOL_SETS[intent.target];
    if (!toolSet)
        return null;
    if (toolSet.expected.includes(toolName)) {
        // Reset block counter on match
        actionGateBlocks.delete(sessionId);
        return null;
    }
    // Mismatch detected
    const key = sessionId || "default";
    const blocks = (actionGateBlocks.get(key) || 0) + 1;
    actionGateBlocks.set(key, blocks);
    const expected = toolSet.expected.slice(0, 3).join(", ");
    const correction = `[意图-行为不匹配: 预期 ${expected}, 实际 ${toolName}] [请使用 ${expected} 等工具, 否则操作将被拦截]`;
    if (blocks > 3) {
        return {
            block: false, // stop blocking after 3
            inject: [correction + ` [⚠️ 已拦截${blocks}次, 建议人工干预]`],
            humanIntervention: true,
        };
    }
    return {
        block: true,
        blockReason: correction,
        inject: [correction],
    };
}
// ═══════════════════════════════════════════════════════
// CT-03: Safety Gate Config (JSON) + Route 统一
// ═══════════════════════════════════════════════════════
const HIGH_RISK_CONFIG_PATH = join(homedir(), ".openclaw", "workspace", "plugins", "harness-hooks", "high-risk-patterns.json");
// ─── Soul Gates YAML Loader (CT-01) ─────────────────
const SOUL_GATES_PATH = join(homedir(), ".openclaw", "workspace", "rules", "soul-gates.yaml");
const AGENTS_RULES_PATH = join(homedir(), ".openclaw", "workspace", "rules", "agents-rules.yaml");
let _soulGatesCache = null;
let _soulGatesMtime = 0;
let _agentsRulesCache = null;
let _agentsRulesMtime = 0;
function loadSoulGates() {
    try {
        if (!existsSync(SOUL_GATES_PATH)) {
            console.log(`[harness-hooks] soul-gates: file not found at ${SOUL_GATES_PATH}`);
            return { version: "0.0.0", gates: [] };
        }
        const stat = statSync(SOUL_GATES_PATH);
        if (_soulGatesCache && stat.mtimeMs === _soulGatesMtime) {
            return _soulGatesCache; // cached by mtime
        }
        const raw = readFileSync(SOUL_GATES_PATH, "utf-8");
        _soulGatesCache = yamlParse(raw);
        _soulGatesMtime = stat.mtimeMs;
        console.log(`[harness-hooks] soul-gates.yaml loaded (v${_soulGatesCache.version}, ${_soulGatesCache.gates?.length || 0} gates)`);
        return _soulGatesCache;
    }
    catch (e) {
        console.log(`[harness-hooks] soul-gates load error: ${e.message?.slice(0, 80)}`);
        return { version: "0.0.0", gates: [] };
    }
}
function loadAgentsRules() {
    try {
        if (!existsSync(AGENTS_RULES_PATH)) {
            return { version: "0.0.0", rules: [] };
        }
        const stat = statSync(AGENTS_RULES_PATH);
        if (_agentsRulesCache && stat.mtimeMs === _agentsRulesMtime) {
            return _agentsRulesCache;
        }
        const raw = readFileSync(AGENTS_RULES_PATH, "utf-8");
        _agentsRulesCache = yamlParse(raw);
        _agentsRulesMtime = stat.mtimeMs;
        console.log(`[harness-hooks] agents-rules.yaml loaded (v${_agentsRulesCache.version}, ${_agentsRulesCache.rules?.length || 0} rules)`);
        return _agentsRulesCache;
    }
    catch (e) {
        console.log(`[harness-hooks] agents-rules load error: ${e.message?.slice(0, 80)}`);
        return { version: "0.0.0", rules: [] };
    }
}
function isSkillWorkshopProposalCreation(event) {
    const toolName = String(event.toolName || "");
    if (!toolName.includes("skill_workshop"))
        return false;
    const action = String(event.params?.action || "");
    return ["create", "update", "revise"].includes(action);
}
// Soul Gate evaluation: check text against gates, return {blocks, injects}
function evaluateSoulGates(text, state, options = {}) {
    const config = loadSoulGates();
    const gates = config.gates || [];
    const blocks = [];
    const injects = [];
    const lowerText = (text || "").toLowerCase();
    const skipGateIds = new Set(options.skipGateIds || []);
    for (const gate of gates) {
        if (skipGateIds.has(gate.id))
            continue;
        if (!gate.triggers)
            continue;
        let triggered = false;
        for (const trigger of gate.triggers) {
            if (!trigger.pattern)
                continue;
            try {
                const regex = new RegExp(trigger.pattern, "i");
                if (regex.test(lowerText)) {
                    triggered = true;
                    break;
                }
            }
            catch { /* skip invalid */ }
        }
        if (!triggered)
            continue;
        const level = (gate.level || "ADVISORY").toUpperCase();
        const action = gate.failure_action || "none";
        const injectMsg = gate.inject_on_trigger || `[soul-gate] ${gate.name} triggered`;
        if (level === "MANDATORY") {
            if (action === "block") {
                blocks.push({ gate: gate.id, reason: injectMsg });
            }
            else if (action === "inject") {
                injects.push(injectMsg);
                // Track five-step algorithm progress
                if (gate.id === "soul-five-step-algorithm" && state.soulGateState) {
                    state.soulGateState.lastTriggered = gate.id;
                }
            }
        }
        else if (level === "ENFORCED") {
            if (action === "inject") {
                injects.push(injectMsg);
            }
            else if (action === "block") {
                blocks.push({ gate: gate.id, reason: injectMsg });
            }
        }
        else if (level === "GUIDED") {
            injects.push(injectMsg);
        }
        // ADVISORY → log only
    }
    return { blocks, injects };
}
let _highRiskConfig = null;
let _highRiskConfigMtime = 0;
function loadHighRiskConfig() {
    try {
        if (!existsSync(HIGH_RISK_CONFIG_PATH)) {
            // Fallback default patterns
            return {
                version: "1.0.0",
                patterns: [
                    { pattern: "gateway", severity: "HIGH", block: true, reason: "gateway 操作" },
                    { pattern: "plugin", severity: "HIGH", block: true, reason: "plugin 操作" },
                    { pattern: "openclaw\\.json", severity: "HIGH", block: true, reason: "配置文件" },
                    { pattern: "load\\.paths", severity: "HIGH", block: true, reason: "load paths" },
                    { pattern: "restart", severity: "MEDIUM", block: false, reason: "restart 操作" },
                    { pattern: "plugins?\\.", severity: "HIGH", block: true, reason: "plugins 配置" },
                    { pattern: "config.*schema", severity: "MEDIUM", block: false, reason: "config schema" },
                    { pattern: "delete\\s|rm\\s|remove\\s", severity: "HIGH", block: true, reason: "删除操作" },
                    { pattern: "dist/index\\.js", severity: "HIGH", block: true, reason: "直接修改 dist" },
                ],
                default_action: "block",
            };
        }
        const stat = statSync(HIGH_RISK_CONFIG_PATH);
        if (_highRiskConfig && stat.mtimeMs === _highRiskConfigMtime) {
            return _highRiskConfig; // cached
        }
        const raw = readFileSync(HIGH_RISK_CONFIG_PATH, "utf-8");
        _highRiskConfig = JSON.parse(raw);
        _highRiskConfigMtime = stat.mtimeMs;
        console.log(`[harness-hooks] high-risk-patterns.json loaded (v${_highRiskConfig.version}, ${_highRiskConfig.patterns?.length || 0} patterns)`);
        return _highRiskConfig;
    }
    catch (e) {
        console.log(`[harness-hooks] high-risk config load error: ${e.message?.slice(0, 60)}`);
        return { version: "0.0.0", patterns: [], default_action: "block" };
    }
}
function classifyRiskLevel(event) {
    const text = event.prompt || JSON.stringify(event.messages || "");
    const config = loadHighRiskConfig();
    for (const p of config.patterns) {
        try {
            const regex = new RegExp(p.pattern, "i");
            if (regex.test(text))
                return { severity: p.severity || "HIGH", preflight: p.preflight !== false, warning: p.preflight_warning || "", reason: p.reason || "" };
        }
        catch { /* skip invalid pattern */ }
    }
    return { severity: "LOW", preflight: false, warning: "", reason: "" };
}
// ═══════════════════════════════════════════════════════
// Shared helpers (preserved from original)
// ═══════════════════════════════════════════════════════
let _stateVersion = 0; // CT-opt: concurrent write guard
// RMW-race fix (CAS + 3-way merge): remember the on-disk snapshot at loadState()
// time so saveState() can compute what THIS read-modify-write changed and re-merge
// it onto a fresher disk state when a concurrent hook wrote in between. Keyed by
// state object reference — loadState() returns a fresh parse every call.
const _stateBases = new WeakMap();
function defaultState() {
    return {
        state: "INACTIVE",
        activeContract: null,
        currentCT: null,
        completedCTs: [],
        completedContracts: [],
        ctSequence: [],
        retryCount: 0,
        startedAt: null,
        lastActivityAt: null,
        lastSeenLC: null,
        modelTier: 0,
        modelFailures: 0,
        consecutiveEmptyResponses: 0,
        successfulCalls: 0,
        modelHistory: [],
        subAgentStates: {
            coder: { handoffDone: false, handoffAt: null, spawnedAt: null },
            spec_reviewer: { spawnedAt: null, passedAt: null, failedAt: null },
            quality_reviewer: { spawnedAt: null, passedAt: null, failedAt: null },
            planner: { handoffDone: false, handoffAt: null, spawnedAt: null },
        },
        // CT-02: Audit Log
        auditLog: [],
        // CT-02: Current intent tracking for action gate
        currentIntent: null,
        // CT-01: Soul Gate State
        soulGateState: {
            fiveStepProgress: [],
            currentStep: 0,
            lastTriggered: null,
            gateHistory: [],
            enabled: true,
        },
    };
}
function getCurrentModel(state) {
    const tiers = getModelTiers();
    return tiers[state.modelTier] || tiers[0];
}
const MODEL_NOTIFY_INTERVAL = 5; // CT-opt: notify every 5 failures
const MAX_MODEL_RETRIES = 20; // CT-opt: suspend after 20 failures
const USE_ASYNC_TELEGRAM = true; // async preferred; false = sync fallback
function sendTelegramAlert(text) {
    try {
        const token = process.env.TELEGRAM_BOT_TOKEN || "";
        const chatId = process.env.TELEGRAM_CHAT_ID || "7664719881";
        if (!token) {
            console.log(`[harness-hooks] sendTelegramAlert: no token, would send: ${text.slice(0, 80)}`);
            return false;
        }
        const payload = JSON.stringify({ chat_id: Number(chatId), text: text.slice(0, 2000) });
        execFile("curl", ["-s", "-X", "POST",
            `https://api.telegram.org/bot${token}/sendMessage`,
            "-H", "Content-Type: application/json",
            "-d", payload,
        ], { timeout: 10000 });
        return true;
    }
    catch (e) {
        console.log(`[harness-hooks] sendTelegramAlert: failed: ${e.message?.slice(0, 60)}`);
        return false;
    }
}
/**
 * sendTelegramAlertAsync — Promise version, fire-and-forget friendly
 */
function sendTelegramAlertAsync(text) {
    return new Promise((resolve) => {
        try {
            const token = process.env.TELEGRAM_BOT_TOKEN || "";
            const chatId = process.env.TELEGRAM_CHAT_ID || "7664719881";
            if (!token) {
                console.log(`[harness-hooks] sendTelegramAlertAsync: no token, would send: ${text.slice(0, 80)}`);
                resolve(false);
                return;
            }
            const payload = JSON.stringify({ chat_id: Number(chatId), text: text.slice(0, 2000) });
            execFile("curl", ["-s", "-X", "POST",
                `https://api.telegram.org/bot${token}/sendMessage`,
                "-H", "Content-Type: application/json",
                "-d", payload,
            ], { timeout: 10000 }, (err) => {
                if (err) {
                    console.log(`[harness-hooks] sendTelegramAlertAsync: failed: ${err.message?.slice(0, 60)}`);
                    resolve(false);
                }
                else {
                    resolve(true);
                }
            });
        }
        catch (e) {
            console.log(`[harness-hooks] sendTelegramAlertAsync: failed: ${e.message?.slice(0, 60)}`);
            resolve(false);
        }
    });
}
function escalateModelTier(state, reason) {
    // Skip if already suspended
    if (state.state === "SUSPECTED_STUCK")
        return false;
    const tiers = getModelTiers();
    const prev = state.modelTier;
    state.modelFailures = (state.modelFailures || 0) + 1;
    state.consecutiveEmptyResponses = (state.consecutiveEmptyResponses || 0) + 1;
    state.modelHistory = state.modelHistory || [];
    state.modelHistory.push({ tier: prev, model: tiers[prev]?.label || "unknown", timestamp: Date.now(), reason });
    // CT-opt: notify every 5 failures
    if (state.modelFailures % MODEL_NOTIFY_INTERVAL === 0) {
        const contractName = state.activeContract || "unknown";
        const ctId = state.currentCT || "?";
        const msg = `⚠️ Harness 模型连续失败 (${state.modelFailures}次)\n合约: ${contractName} | ${ctId}\n上次模型: ${tiers[prev]?.label || "unknown"}: ${reason.slice(0, 60)}`;
        if (USE_ASYNC_TELEGRAM) {
            sendTelegramAlertAsync(msg).catch(() => { });
        }
        else {
            sendTelegramAlert(msg);
        }
        console.log(`[harness-hooks] MODEL_NOTIFY: ${contractName} (${state.modelFailures} failures)`);
    }
    // CT-opt: max retries exceeded → suspend
    if (state.modelFailures >= MAX_MODEL_RETRIES) {
        const contractName = state.activeContract || "unknown";
        const ctId = state.currentCT || "?";
        const lastModel = tiers[prev]?.label || "unknown";
        console.log(`[harness-hooks] MAX_RETRIES (${MAX_MODEL_RETRIES}): contract=${contractName}, suspending`);
        const msg = `⛔ Harness 合约暂停: ${contractName} | ${ctId}\n原因: 模型连续失败 ${state.modelFailures} 次，已暂停\n最后模型: ${lastModel}: ${reason.slice(0, 60)}`;
        if (USE_ASYNC_TELEGRAM) {
            sendTelegramAlertAsync(msg).catch(() => { });
        }
        else {
            sendTelegramAlert(msg);
        }
        transitionState(state, "SUSPECTED_STUCK", `max retries (${MAX_MODEL_RETRIES}) exceeded`);
        return false;
    }
    if (prev >= tiers.length - 1) {
        console.log(`[harness-hooks] model fallback: at last tier, retry #${state.modelFailures}`);
        return true;
    }
    state.modelTier = prev + 1;
    console.log(`[harness-hooks] model fallback: ${tiers[prev]?.label} → ${tiers[state.modelTier]?.label} (${reason})`);
    return true;
}
function resetModelTier(state) {
    const tiers = getModelTiers();
    if (state.modelTier !== 0) {
        console.log(`[harness-hooks] model reset: ${tiers[state.modelTier].label} → ${tiers[0].label}`);
        state.modelTier = 0;
        state.consecutiveEmptyResponses = 0;
    }
}
// ─── CT completion helpers ──────────────────────────────────────
function advanceToNextCT(state) {
    // Mark current CT complete and advance to next
    const current = state.currentCT;
    if (!current || !state.ctSequence || state.ctSequence.length === 0)
        return false;
    if (!state.completedCTs)
        state.completedCTs = [];
    if (!state.completedCTs.includes(current)) {
        state.completedCTs.push(current);
    }
    // Reset per-CT counters
    state.retryCount = 0;
    state.modelFailures = 0;
    state.consecutiveEmptyResponses = 0;
    state.modelTier = 0;
    state.successfulCalls = 0;
    state.subAgentStates = JSON.parse(JSON.stringify(getDefaultSubAgentStates()));
    const seq = state.ctSequence;
    const idx = seq.indexOf(current);
    if (idx >= 0 && idx < seq.length - 1) {
        state.currentCT = seq[idx + 1];
        console.log(`[harness-hooks] CT advance: ${current} → ${state.currentCT}`);
        return true;
    }
    // Last CT → complete contract
    if (!state.completedContracts)
        state.completedContracts = [];
    if (state.activeContract && !state.completedContracts.includes(state.activeContract)) {
        state.completedContracts.push(state.activeContract);
    }
    const contractName = state.activeContract;
    state.activeContract = null;
    state.currentCT = null;
    state.ctSequence = [];
    state.completedCTs = [];
    state.modelFailures = 0;
    state.modelTier = 0;
    state.lastSeenLC = null;
    transitionState(state, "STOPPED", `completed contract ${contractName}`);
    transitionState(state, "INACTIVE", `normalizing after completed contract`);
    console.log(`[harness-hooks] contract complete: ${contractName}, all CTs done`);
    return true;
}
function detectModelFailure(event) {
    const result = event.result || {};
    const output = result.stdout || result.text || result.stderr || "";
    const error = result.error || "";
    const combined = (output + " " + error).trim();
    const toolName = event.toolName || "";
    const SKIP_TOOLS = ["exec", "read", "message", "apply_patch", "wait", "web_search", "web_fetch", "web_scrape", "memory_get", "memory_search", "process_log"];
    if (SKIP_TOOLS.includes(toolName))
        return null;
    if (!combined || combined.length < 20)
        return "empty response";
    for (const pat of getModelDeadPatterns()) {
        if (pat.test(combined))
            return combined.substring(0, 80);
    }
    return null;
}
function isContractRuntimeActive(state) {
    if (!state.activeContract)
        return false;
    return ["LC_ACTIVE", "CT_RUNNING", "SPEC_REVIEW", "QUALITY_REVIEW", "INTEGRATION_VERIFY", "SUSPECTED_STUCK", "ARBITER_BLOCKED"].includes(state.state);
}
function isComplexTask(event) {
    const text = event.prompt || JSON.stringify(event.messages || "");
    for (const kw of getComplexTaskKeywords()) {
        if (text.toLowerCase().includes(kw))
            return true;
    }
    return false;
}
// CT-02: Audit Log helpers
function appendAuditLog(state, entry) {
    if (!state.auditLog)
        state.auditLog = [];
    state.auditLog.push({
        type: entry.type || "tool_call",
        agent: entry.agent || "main",
        tool: entry.tool || "",
        target: entry.target || "",
        ts: Date.now(),
        result: entry.result || "",
        toolCallId: entry.toolCallId || "",
    });
    // Auto-trim: keep last 100, prune to 50
    if (state.auditLog.length > 100) {
        state.auditLog = state.auditLog.slice(-50);
    }
}
function getRecentAuditLog(state, count) {
    if (!state.auditLog || state.auditLog.length === 0)
        return [];
    return state.auditLog.slice(-(count || 5));
}
// CT-02: Spawn decision based on auditLog (primary) or subAgentStates (fallback)
function shouldTriggerSpawn(state) {
    // 🔴 FIX: 只有存在活跃合约时才触发 spawn（2026-07-28）
    // 本意是合约工作流中自动 spawn reviewer，
    // 但之前 state.state 残留会导致所有对话都触发
    if (!state.activeContract)
        return false;
    // Only trigger in states that need reviewer spawn
    if (state.state !== "SPEC_REVIEW" && state.state !== "QUALITY_REVIEW")
        return false;
    const recent = getRecentAuditLog(state, 5);
    if (recent.length > 0) {
        // Check recent audit entries for coder handoff pattern
        const hasCoderActivity = recent.some(e => e.type === "handoff" || (e.tool === "write" && e.target && e.target.includes("handoff")));
        const hasNoReviewerSpawn = !recent.some(e => e.tool === "sessions_spawn" && e.target && (e.target.includes("reviewer") || e.target.includes("review") || e.target.includes("spec") || e.target.includes("quality")));
        if (hasCoderActivity && hasNoReviewerSpawn)
            return true;
        return false;
    }
    // Fallback to subAgentStates + handoff.md detection
    const sas = state.subAgentStates;
    if (sas && sas.coder && sas.coder.handoffDone === true) {
        const reviewerSpawned = (sas.spec_reviewer && sas.spec_reviewer.spawnedAt !== null) ||
            (sas.quality_reviewer && sas.quality_reviewer.spawnedAt !== null);
        return !reviewerSpawned;
    }
    return false;
}
const PREFLIGHT_SCRIPT = join(homedir(), ".openclaw", "workspace", "scripts", "gateway_preflight.sh");
function runPreflightCheck() {
    if (!existsSync(PREFLIGHT_SCRIPT)) {
        console.log(`[harness-hooks] preflight: script not found at ${PREFLIGHT_SCRIPT}`);
        return "SKIP";
    }
    try {
        const result = execFileSync("bash", [PREFLIGHT_SCRIPT], { timeout: 30000, encoding: "utf-8" });
        if (result.includes("All checks passed")) {
            console.log(`[harness-hooks] preflight: PASS`);
            return "PASS";
        }
        console.log(`[harness-hooks] preflight: FAIL`);
        return "FAIL";
    }
    catch (e) {
        console.log(`[harness-hooks] preflight: ERROR — ${e.message.slice(0, 60)}`);
        return "ERROR";
    }
}
/**
 * runPreflightCheckAsync — Promise version, uses execFile
 */
function runPreflightCheckAsync() {
    return new Promise((resolve) => {
        if (!existsSync(PREFLIGHT_SCRIPT)) {
            console.log(`[harness-hooks] preflightAsync: script not found at ${PREFLIGHT_SCRIPT}`);
            resolve("SKIP");
            return;
        }
        execFile("bash", [PREFLIGHT_SCRIPT], { timeout: 30000, encoding: "utf-8" }, (err, stdout) => {
            if (err) {
                console.log(`[harness-hooks] preflightAsync: ERROR — ${err.message.slice(0, 60)}`);
                resolve("ERROR");
            }
            else if (stdout.includes("All checks passed")) {
                console.log(`[harness-hooks] preflightAsync: PASS`);
                resolve("PASS");
            }
            else {
                console.log(`[harness-hooks] preflightAsync: FAIL`);
                resolve("FAIL");
            }
        });
    });
}
// ─────────────────────────────────────────────────────
// RESTART-PREFLIGHT GATE (hardcoded, tightened v2)
// ─────────────────────────────────────────────────────
const RESTART_PATTERNS = [
    /openclaw\s+gateway\s+restart/i, /openclaw\s+restart/i,
    /gateway.*(start|stop|reload)/i,
    /plugins.*(add|remove|update|config)/i,
    /load\.paths/i, /config.*schema/i,
    /npx.*openclaw.*(config|restart|stop|start)/i,
];
function checkRestartPreflightGate(event) {
    const text = JSON.stringify(event.params || {});
    const cmd = String(event.params?.command || "");
    if (cmd.includes("node --check"))
        return null;
    for (const pattern of RESTART_PATTERNS) {
        if (pattern.test(text)) {
            console.log("[harness-hooks] GATE: matched " + pattern + " — preflight");
            const pf = runPreflightCheck();
            if (pf !== "PASS") {
                return {
                    block: true,
                    blockReason: "[GATE] preflight fail (" + pf + "). Fix then retry.",
                    inject: ["[GATE] operation blocked - preflight: " + pf],
                };
            }
            console.log("[harness-hooks] GATE: PASS");
            return { inject: ["[GATE] preflight passed"] };
        }
    }
    return null;
}
/**
 * runHarnessValidator(intent, state, event) — CT-03
 * 调用 scripts/harness_validator.py CLI 进行三段验证
 * Returns {pass, warnings, blocks, injects} or null on error
 */
const USE_ASYNC_VALIDATOR = true; // async preferred; false = sync fallback
function runHarnessValidator(intent, state, event) {
    try {
        const VALIDATOR_SCRIPT = join(homedir(), ".openclaw", "workspace", "scripts", "harness_validator.py");
        if (!existsSync(VALIDATOR_SCRIPT)) {
            console.log(`[harness-hooks] validator: script not found`);
            return null;
        }
        const intentJson = JSON.stringify({
            intent_type: intent.intent_type,
            target: intent.target,
            confidence: intent.confidence,
            matchedKeyword: intent.matchedKeyword,
            sub_intent: intent.sub_intent,
        });
        const stateJson = JSON.stringify({
            state: state.state,
            activeContract: state.activeContract,
            currentCT: state.currentCT,
            soulGateState: state.soulGateState || {},
        });
        const stdout = execFileSync("python3", [VALIDATOR_SCRIPT, "--intent", intentJson, "--state", stateJson], { timeout: 10000, encoding: "utf-8" });
        const parsed = JSON.parse(stdout.trim());
        return parsed;
    }
    catch (e) {
        console.log(`[harness-hooks] validator error: ${e.message?.slice(0, 80)}`);
        return null;
    }
}
/**
 * runHarnessValidatorAsync — Promise version, uses execFile callback
 * Same return structure as sync runHarnessValidator
 */
function runHarnessValidatorAsync(intent, state, event) {
    return new Promise((resolve) => {
        try {
            const VALIDATOR_SCRIPT = join(homedir(), ".openclaw", "workspace", "scripts", "harness_validator.py");
            if (!existsSync(VALIDATOR_SCRIPT)) {
                console.log(`[harness-hooks] validator: script not found`);
                resolve(null);
                return;
            }
            const intentJson = JSON.stringify({
                intent_type: intent.intent_type,
                target: intent.target,
                confidence: intent.confidence,
                matchedKeyword: intent.matchedKeyword,
                sub_intent: intent.sub_intent,
            });
            const stateJson = JSON.stringify({
                state: state.state,
                activeContract: state.activeContract,
                currentCT: state.currentCT,
                soulGateState: state.soulGateState || {},
            });
            execFile("python3", [VALIDATOR_SCRIPT, "--intent", intentJson, "--state", stateJson], { timeout: 10000, encoding: "utf-8" }, (err, stdout) => {
                if (err) {
                    console.log(`[harness-hooks] validatorAsync error: ${err.message?.slice(0, 80)}`);
                    resolve(null);
                }
                else {
                    resolve(JSON.parse(stdout.trim()));
                }
            });
        }
        catch (e) {
            console.log(`[harness-hooks] validatorAsync error: ${e.message?.slice(0, 80)}`);
            resolve(null);
        }
    });
}
function buildModelRoutingContext(state) {
    const model = getCurrentModel(state);
    const lines = [];
    if (state.modelTier > 0) {
        lines.push(`[model-routing: use ${model.label} — previous model failed after ${state.modelFailures} failure(s)]`);
    }
    if ((state.consecutiveEmptyResponses || 0) >= 2) {
        const tiers = getModelTiers();
        const next = tiers[Math.min(state.modelTier + 1, tiers.length - 1)];
        lines.push(`[model-routing: **consecutive failures** — if this model fails, try ${next.label}]`);
    }
    if (state.modelHistory?.length > 0) {
        const recent = state.modelHistory.slice(-3).map(h => `${h.model}(${h.reason.slice(0, 30)})`).join(" → ");
        lines.push(`[model-history: ${recent}]`);
    }
    return lines;
}
// ─── RMW race fix: CAS + 3-way merge helpers ────────
// Persistence / internal meta keys — never merged as data, never carried in diffs.
const STATE_META_KEYS = new Set(["_version", "_savedAt"]);
function _cloneState(s) {
    // State is JSON-serializable (it is persisted as JSON), so a JSON round-trip
    // is a correct deep clone.
    return JSON.parse(JSON.stringify(s));
}
function _isPlainObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}
function _deepEqual(a, b) {
    if (a === b)
        return true;
    if (a == null || b == null)
        return a === b;
    if (typeof a !== "object" || typeof b !== "object")
        return false;
    const aArr = Array.isArray(a), bArr = Array.isArray(b);
    if (aArr || bArr) {
        if (!aArr || !bArr)
            return false;
        if (a.length !== b.length)
            return false;
        for (let i = 0; i < a.length; i++)
            if (!_deepEqual(a[i], b[i]))
                return false;
        return true;
    }
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length)
        return false;
    for (const k of ka)
        if (!_deepEqual(a[k], b[k]))
            return false;
    return true;
}
// 3-way merge of "ours" (this RMW's resulting state) onto "disk" (the freshest
// concurrent state committed since we loaded), using "base" (what we loaded) to
// tell what we actually changed:
//   - fields we did NOT touch → keep disk (preserve the concurrent writer)
//   - fields we DID touch → our value wins, EXCEPT arrays are append-merged so
//     concurrent appends (auditLog / modelHistory / gateHistory …) aren't lost;
//     an array whose prefix no longer equals base is treated as a wholesale
//     replace (e.g. ctSequence) → caller wins.
function _mergeConcurrent(disk, base, ours) {
    // Nothing changed under our RMW → keep whatever the concurrent writer left.
    if (_deepEqual(base, ours))
        return disk;
    if (disk == null)
        return ours;
    if (Array.isArray(base) && Array.isArray(ours)) {
        if (!Array.isArray(disk))
            return ours;
        const isAppend = base.length === 0 || _deepEqual(ours.slice(0, base.length), base);
        if (isAppend) {
            const added = ours.slice(base.length);
            const tail = added.filter(a => !disk.some(d => _deepEqual(d, a))); // dedup identical
            return disk.concat(tail); // keep disk's concurrent appends, then add ours
        }
        return ours; // replace semantics → caller wins
    }
    // Plain objects: recurse field-by-field so concurrent changes to sibling
    // fields (e.g. subAgentStates.planner.doneAt vs .coder.doneAt) are preserved.
    if (_isPlainObj(base) && _isPlainObj(ours) && _isPlainObj(disk)) {
        const out = { ...disk };
        for (const k of Object.keys(ours)) {
            if (STATE_META_KEYS.has(k))
                continue;
            if (_deepEqual(base[k], ours[k]))
                continue; // unchanged by us → keep disk[k]
            out[k] = _mergeConcurrent(disk[k], base[k], ours[k]);
        }
        return out;
    }
    // Scalar we touched, or type changed → caller wins.
    return ours;
}
// Test-only internals: exported so the CAS/merge logic can be unit-tested against
// the compiled artifact (dist/index.js). Not used by the plugin runtime path.
export const _rmwCasInternals = { _deepEqual, _mergeConcurrent, _cloneState };
function loadState() {
    if (!existsSync(STATE_FILE)) {
        const fresh = defaultState();
        _stateBases.set(fresh, _cloneState(fresh));
        return fresh;
    }
    try {
        const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
        const defaults = defaultState();
        for (const k of Object.keys(defaults)) {
            if (!(k in raw))
                raw[k] = defaults[k];
        }
        // Track version for concurrent write detection
        _stateVersion = raw._version || 0;
        // CT-01: Auto-migrate REVIEW_PENDING → SPEC_REVIEW
        if (raw.state === "REVIEW_PENDING") {
            raw.state = "SPEC_REVIEW";
            console.log(`[harness-hooks] state migration: REVIEW_PENDING → SPEC_REVIEW`);
        }
        // RMW-race fix: snapshot the on-disk state at load time so saveState() can
        // 3-way merge our later changes onto a fresher disk if a concurrent hook
        // wrote in between (compare-and-swap). Keyed by object ref (fresh per load).
        _stateBases.set(raw, _cloneState(raw));
        return raw;
    }
    catch {
        const fresh = defaultState();
        _stateBases.set(fresh, _cloneState(fresh));
        return fresh;
    }
}
function saveState(state) {
    const defaults = defaultState();
    for (const k of Object.keys(defaults)) {
        if (!(k in state))
            state[k] = defaults[k];
    }
    // RMW-race fix (CAS + 3-way merge): the version we loaded is captured in the
    // base snapshot (_stateBases). Inside the lock we re-read disk; if a concurrent
    // hook committed a newer state since our load, we re-merge OUR changes onto the
    // fresher disk instead of clobbering it (no last-writer-wins data loss).
    const base = _stateBases.get(state);
    const loadedVersion = base ? (base._version || 0) : (state._version || 0);
    // CT-01: Atomic write (write .tmp + rename)
    // P2: protect write with state lock (use toggle for quick-disable)
    const tmpFile = STATE_FILE + ".tmp";
    const doWrite = () => {
        let disk = null, diskVersion = 0;
        try {
            if (existsSync(STATE_FILE)) {
                disk = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
                diskVersion = disk._version || 0;
            }
        }
        catch (e) {
            console.log(`[harness-hooks] saveState disk read skipped: ${(e?.message || "").slice(0, 60)}`);
        }
        let finalState = state;
        if (disk && diskVersion > loadedVersion) {
            if (base) {
                finalState = _mergeConcurrent(disk, base, state);
                console.warn(`[harness-hooks] CONCURRENT WRITE resolved via 3-way merge (disk v${diskVersion} > loaded v${loadedVersion})`);
            }
            else {
                // State not from loadState (no base): can't merge safely — preserve the
                // legacy direct-write but log loudly. All current callers go through loadState.
                console.warn(`[harness-hooks] CONCURRENT WRITE: disk v${diskVersion} > v${loadedVersion}, no base to merge — direct write (data may be lost)`);
            }
        }
        finalState = _cloneState(finalState);
        finalState._version = Math.max(diskVersion, loadedVersion) + 1;
        finalState._savedAt = Date.now();
        _stateVersion = finalState._version;
        writeFileSync(tmpFile, JSON.stringify(finalState, null, 2));
        renameSync(tmpFile, STATE_FILE);
        // Refresh the base snapshot to the committed state so a subsequent save of
        // the SAME object sees no false conflict (and arrays don't double-append).
        _stateBases.set(state, _cloneState(finalState));
        state._version = finalState._version;
        state._savedAt = finalState._savedAt;
    };
    if (USE_STATE_LOCK) {
        withStateLock(doWrite);
    }
    else {
        doWrite();
    }
}
// CT-01: Rotate transitions log if >LOG_ROTATE_THRESHOLD_BYTES
// Numbered suffix shift pattern: max 20 generations
function rotateTransitionsLogIfNeeded() {
    try {
        if (!existsSync(TRANSITIONS_LOG))
            return;
        const stats = statSync(TRANSITIONS_LOG);
        if (stats.size > LOG_ROTATE_THRESHOLD_BYTES) {
            const MAX_BACKUPS = 20;
            // Delete the oldest backup (.20) if it exists to maintain max 20 generations
            try {
                unlinkSync(TRANSITIONS_LOG + ".20");
            }
            catch { /* ignore if not exists */ }
            // Shift backups: .19→.20, .18→.19, ..., .1→.2
            for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
                const src = `${TRANSITIONS_LOG}.${i}`;
                const dst = `${TRANSITIONS_LOG}.${i + 1}`;
                try {
                    renameSync(src, dst);
                }
                catch { /* ignore if source doesn't exist */ }
            }
            // Rename current log to .1
            renameSync(TRANSITIONS_LOG, TRANSITIONS_LOG + ".1");
            console.log(`[harness-hooks] transitions log rotated (>${LOG_ROTATE_THRESHOLD_BYTES} bytes)`);
        }
    }
    catch (e) {
        console.log(`[harness-hooks] transitions log rotate error: ${e.message?.slice(0, 60)}`);
    }
}
function transitionState(state, newState, reason) {
    const oldState = state.state;
    if (oldState === newState)
        return;
    state.state = newState;
    state.lastActivityAt = Date.now();
    const ctId = state.currentCT || "-";
    // CT-02: Append structured log line
    try {
        rotateTransitionsLogIfNeeded();
        const iso = new Date().toISOString();
        const line = `${iso}\t${oldState}\t${newState}\t${reason || "-"}\t${ctId}\n`;
        appendFileSync(TRANSITIONS_LOG, line, "utf-8");
    }
    catch (e) {
        console.log(`[harness-hooks] transitions log write error: ${e.message?.slice(0, 60)}`);
    }
    console.log(`[harness-hooks] state: ${oldState} → ${newState}${reason ? ` (${reason})` : ""}`);
}
// ─── Verify helpers: read contract verify commands & run them ──
function findContractFilePath(state) {
    if (!state.activeContract)
        return null;
    try {
        const files = readdirSync(CONTRACTS_DIR);
        for (const f of files) {
            if (f === state.activeContract || f.startsWith(state.activeContract + ".")) {
                return join(CONTRACTS_DIR, f);
            }
        }
    }
    catch (e) {
        console.log(`[harness-hooks] findContractFilePath: ${e.message?.slice(0, 60)}`);
    }
    return null;
}
function extractVerifyCommands(contractPath) {
    const cmds = [];
    try {
        const content = readFileSync(contractPath, "utf-8");
        // Strategy 1: YAML verify block in body
        const yamlMatch = content.match(/verify:\s*\n((?:\s*-\s+[^\n]+\n?)+)/m);
        if (yamlMatch) {
            const items = yamlMatch[1].match(/-\s+(.+)/g) || [];
            for (const item of items) {
                const cmd = item.replace(/^-\s+/, "").trim().replace(/^['"]|['"]$/g, "");
                if (cmd)
                    cmds.push(cmd);
            }
        }
        // Strategy 2: ## Verify section with backtick commands
        if (cmds.length === 0) {
            const verifySection = content.match(/##\s*Verify(?:检查)?\s*\n([\s\S]*?)(?:\n##|\n$|$)/);
            if (verifySection) {
                const cmdMatches = verifySection[1].match(/`([^`]+)`/g) || [];
                for (const m of cmdMatches) {
                    cmds.push(m.replace(/`/g, ""));
                }
            }
        }
        console.log(`[harness-hooks] extractVerifyCommands: ${cmds.length} commands extracted from ${contractPath}`);
    }
    catch (e) {
        console.log(`[harness-hooks] extractVerifyCommands: FAILED — ${e.message?.slice(0, 60)}`);
    }
    return cmds;
}
function runContractVerify(state) {
    const contractPath = findContractFilePath(state);
    if (!contractPath)
        return { passed: true, summary: "no contract file found, skipping verify", results: [] };
    const cmds = extractVerifyCommands(contractPath);
    if (cmds.length === 0)
        return { passed: true, summary: "no verify commands in contract, skipping", results: [] };
    const results = [];
    for (let i = 0; i < cmds.length; i++) {
        const cmd = cmds[i];
        try {
            const output = execFileSync("bash", ["-c", cmd], { encoding: "utf-8", timeout: 30000, maxBuffer: 1024 * 1024 }).trim();
            results.push({ cmd, passed: true, output: output.slice(0, 200) });
            console.log(`[harness-hooks] verify [${i + 1}/${cmds.length}] PASS: ${cmd.slice(0, 60)}`);
        }
        catch (e) {
            const errMsg = (e.stderr || e.message || "").toString().trim().slice(0, 200);
            results.push({ cmd, passed: false, output: errMsg });
            console.log(`[harness-hooks] verify [${i + 1}/${cmds.length}] FAIL: ${cmd.slice(0, 60)} → ${errMsg.slice(0, 60)}`);
        }
    }
    const passed = results.every(r => r.passed);
    const summary = passed
        ? `ALL ${results.length} verify check(s) passed`
        : results.filter(r => !r.passed).map(r => `✗ ${r.cmd}: ${r.output}`).join("; ");
    return { passed, summary, results };
}
// ─── Integration verify helpers: end-to-end smoke test after all CTs ──
function extractIntegrationVerifyCommands(contractPath) {
    const cmds = [];
    try {
        const content = readFileSync(contractPath, "utf-8");
        // Strategy 1: YAML integration_verify block
        const yamlMatch = content.match(/integration_verify:\s*\n((?:\s*-\s+[^\n]+\n?)+)/m);
        if (yamlMatch) {
            const items = yamlMatch[1].match(/-\s+(.+)/g) || [];
            for (const item of items) {
                const cmd = item.replace(/^-\s+/, "").trim().replace(/^['"]|['"]$/g, "");
                if (cmd)
                    cmds.push(cmd);
            }
        }
        // Strategy 2: ## Integration Verify section with backtick commands
        if (cmds.length === 0) {
            const verifySection = content.match(/##\s*Integration Verify\s*\n([\s\S]*?)(?:\n##|\n$|$)/);
            if (verifySection) {
                const cmdMatches = verifySection[1].match(/`([^`]+)`/g) || [];
                for (const m of cmdMatches) {
                    cmds.push(m.replace(/`/g, ""));
                }
            }
        }
        console.log(`[harness-hooks] extractIntegrationVerifyCommands: ${cmds.length} commands extracted from ${contractPath}`);
    }
    catch (e) {
        console.log(`[harness-hooks] extractIntegrationVerifyCommands: FAILED — ${e.message?.slice(0, 60)}`);
    }
    return cmds;
}
function runIntegrationVerify(commands) {
    const results = [];
    for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        try {
            const output = execFileSync("bash", ["-c", cmd], { encoding: "utf-8", timeout: 60000, maxBuffer: 2 * 1024 * 1024 }).trim();
            results.push({ cmd, passed: true, output: output.slice(0, 200) });
            console.log(`[harness-hooks] integration verify [${i + 1}/${commands.length}] PASS: ${cmd.slice(0, 60)}`);
        }
        catch (e) {
            const errMsg = (e.stderr || e.message || "").toString().trim().slice(0, 300);
            results.push({ cmd, passed: false, output: errMsg });
            console.log(`[harness-hooks] integration verify [${i + 1}/${commands.length}] FAIL: ${cmd.slice(0, 60)} → ${errMsg.slice(0, 60)}`);
        }
    }
    const passed = results.every(r => r.passed);
    const summary = passed
        ? `ALL ${results.length} integration check(s) passed`
        : results.filter(r => !r.passed).map(r => `✗ ${r.cmd}: ${r.output}`).join("; ");
    return { passed, summary, results };
}
function findLatestLC() {
    if (!existsSync(CONTRACTS_DIR))
        return null;
    let latest = null;
    let latestMtime = 0;
    try {
        const files = readdirSync(CONTRACTS_DIR);
        for (const f of files) {
            if (!f.startsWith("LC-"))
                continue;
            const ext = f.substring(f.lastIndexOf("."));
            if (!LC_EXTENSIONS.includes(ext.toLowerCase()))
                continue;
            const fullPath = join(CONTRACTS_DIR, f);
            try {
                // Skip contracts with CLOSED/ARCHIVED meta status
                const head = readFileSync(fullPath, "utf-8").split("\n").slice(0, 25).join("\n");
                if (/\|\s*状态\s*\|\s*(CLOSED|ARCHIVED)\s*\|/i.test(head) || /^status\s*:\s*(CLOSED|ARCHIVED)\s*$/im.test(head)) {
                    console.log(`[harness-hooks] findLatestLC: skip ${f} (CLOSED/ARCHIVED)`);
                    continue;
                }
                const stat = statSync(fullPath);
                if (stat.mtimeMs > latestMtime) {
                    latestMtime = stat.mtimeMs;
                    latest = { name: f.replace(/\.[^.]+$/, ""), path: fullPath, mtime: stat.mtimeMs };
                }
            }
            catch { /* skip */ }
        }
    }
    catch { /* dir unreadable */ }
    return latest;
}
function parseCTSequence(lcPath) {
    const cts = [];
    try {
        const content = readFileSync(lcPath, "utf-8");
        // Strategy 1: YAML front matter or bullet list
        const yamlMatch = content.match(/^(?:cts?|contract_tasks?):\s*\n((?:\s*-\s+.+\n?)+)/m);
        if (yamlMatch) {
            const items = yamlMatch[1].match(/-\s+(.+)/g) || [];
            for (const item of items) {
                const id = item.replace(/^-\s+/, "").trim();
                if (id)
                    cts.push(id);
            }
        }
        // Strategy 2: Markdown list items with backtick CT IDs
        if (cts.length === 0) {
            const mdMatches = content.match(/^[-*]\s+`(CT-\S+)`/gm) || [];
            for (const m of mdMatches) {
                const id = m.match(/`(CT-\S+)`/);
                if (id)
                    cts.push(id[1]);
            }
        }
        // Strategy 3: Markdown table cells (| CT-01 | ... |)
        if (cts.length === 0) {
            const tableMatches = content.match(/\|\s*(CT-\d{2,3})\s*\|/g) || [];
            const seen = new Set();
            for (const m of tableMatches) {
                const id = m.match(/(CT-\d{2,3})/);
                if (id && !seen.has(id[1])) {
                    seen.add(id[1]);
                    cts.push(id[1]);
                }
            }
        }
        // Strategy 4: Markdown headings (## CT-01 or ### CT-01) — CT-opt: lenient prefix
        if (cts.length === 0) {
            const headingMatches = content.match(/^[#]{2,3}\s+(CT-\d{2,4})/gm) || [];
            const seen = new Set();
            for (const m of headingMatches) {
                const id = m.match(/(CT-\d{2,4})/);
                if (id && !seen.has(id[1])) {
                    seen.add(id[1]);
                    cts.push(id[1]);
                }
            }
        }
        // Strategy 5: === heading style
        if (cts.length === 0) {
            const eqMatches = content.match(/^(CT-\d{2,4})\n[-=]+$/gm) || [];
            for (const m of eqMatches) {
                const id = m.match(/^(CT-\d{2,4})/);
                if (id)
                    cts.push(id[1]);
            }
        }
        // Strategy 6: Relaxed "### CT-01: title" — no line-begin anchor
        if (cts.length === 0) {
            const relaxedMatches = content.match(/#{2,4}\s+(CT-\d{2,4})/g) || [];
            const seen = new Set();
            for (const m of relaxedMatches) {
                const id = m.match(/(CT-\d{2,4})/);
                if (id && !seen.has(id[1])) {
                    seen.add(id[1]);
                    cts.push(id[1]);
                }
            }
        }
        // Strategy 7: ANY occurrence of CT-NNN pattern
        if (cts.length === 0) {
            const anyMatches = content.match(/CT-\d{2,4}/g) || [];
            const seen = new Set();
            for (const m of anyMatches) {
                if (!seen.has(m)) {
                    seen.add(m);
                    cts.push(m);
                }
            }
        }
        console.log(`[harness-hooks] parseCTSequence: ${lcPath} → ${cts.length > 0 ? cts.join(", ") : "(no CTs parsed)"}`);
    }
    catch (e) {
        console.log(`[harness-hooks] parseCTSequence: FAILED — ${e.message?.slice(0, 60)}`);
    }
    return cts;
}
function checkLCActivation(state) {
    const lc = findLatestLC();
    if (!lc)
        return;
    // Skip already-completed contracts
    const completed = state.completedContracts || [];
    if (completed.includes(lc.name)) {
        // Normalize state to INACTIVE to avoid prompt injection if left in LC_ACTIVE
        if (state.state === "LC_ACTIVE" || state.state === "CT_RUNNING" || state.state === "SPEC_REVIEW" || state.state === "QUALITY_REVIEW" || state.state === "INTEGRATION_VERIFY") {
            transitionState(state, "STOPPED", `completed contract ${lc.name}`);
            transitionState(state, "INACTIVE", `normalizing after completed contract`);
            state.activeContract = null;
            state.currentCT = null;
            state.lastSeenLC = null;
            saveState(state);
            console.log(`[harness-hooks] normalized completed contract ${lc.name}: LC_ACTIVE → INACTIVE`);
        }
        return;
    }
    if (state.state === "LC_DONE" || state.state === "STOPPED") {
        const preserved = (state.completedContracts || []).slice();
        const newState = defaultState();
        Object.assign(state, newState);
        state.completedContracts = preserved;
        state.lastSeenLC = null;
        console.log(`[harness-hooks] state reset: ${state.state} → INACTIVE (new LC detected)`);
    }
    if (state.lastSeenLC === lc.name && state.state !== "INACTIVE")
        return;
    state.lastSeenLC = lc.name;
    state.activeContract = lc.name;
    state.startedAt = Date.now();
    const cts = parseCTSequence(lc.path);
    if (cts.length > 0) {
        state.ctSequence = cts;
        state.currentCT = cts[0];
        state.completedCTs = [];
        state.retryCount = 0;
        transitionState(state, "LC_ACTIVE", `detected ${lc.name}`);
    }
    else {
        state.ctSequence = [];
        state.currentCT = null;
        state.completedCTs = [];
        transitionState(state, "LC_ACTIVE", `detected ${lc.name} (no CTs parsed)`);
    }
    saveState(state);
}
function classifyTaskLength(event) {
    const text = event.prompt || JSON.stringify(event.messages || "");
    const fileCount = (text.match(/\/[\w\/.-]+\.[a-z]+/g) || []).length;
    if (fileCount > 2)
        return "LONG";
    const dirs = new Set((text.match(/([\w-]+)\//g) || []).map(d => d.replace('/', '')));
    if (dirs.size > 3)
        return "LONG";
    const codeBlockLines = (text.match(/```[\s\S]*?```/g) || []).join('').split('\n').length;
    if (codeBlockLines > 50)
        return "LONG";
    return "SHORT";
}
// ═══════════════════════════════════════════════════════
// Unified Route Inject Format (CT-03)
// ═══════════════════════════════════════════════════════
function buildRouteInject(intent, matchedKeyword) {
    return [
        `[ROUTE: ${intent.intent_type}] [read: skills/${intent.target}/SKILL.md]`,
        `[matched: "${matchedKeyword}" → ${intent.target}]`,
    ];
}
// QMD memory-retrieval routing guidance — injected on every prompt_build turn
// (both contract-active and non-contract paths). Single source of truth.
const MEMORY_ROUTING_INJECT = `[MEMORY-RETRIEVAL] QMD 优先路由规则（来源: memory_routing.py）:\n- 任何需要查记忆/文档的查询，必须先 exec qmd query <query> -c memory -n 5\n- 解析 qmd 结果 top score（百分比）。若 top score ≥ 40%，直接使用 qmd 结果\n- 若无结果或 top score < 40%，fallback 到 memory_search / memory_get\n- 禁止跳过 qmd 直走 memory_search，除非 qmd CLI 不可用或超时（限额 30s）\n- qmd query 超时(>30s)或报错时，自动降级到内置 memory_search`;
// ═══════════════════════════════════════════════════════
// CT-02: Trace JSONL Dumper — 子 agent 执行轨迹持久化
// ═══════════════════════════════════════════════════════
const TRACES_DIR = join(homedir(), ".openclaw", "workspace", "scripts", "traces");
// ─── Config-based Agent Type Inference ──────────────
function inferAgentTypeFromConfig(combined) {
    const cfg = loadConfig();
    if (!cfg?.agents)
        return null;
    const lower = combined.toLowerCase();
    for (const [type, agentCfg] of Object.entries(cfg.agents)) {
        const pats = agentCfg.detection?.patterns;
        if (!pats)
            continue;
        for (const pat of pats) {
            try {
                const re = new RegExp(pat, "i");
                if (re.test(lower))
                    return type;
            }
            catch (e) {
                // skip invalid pattern
            }
        }
    }
    return null;
}
function dumpTraceJsonl(event, agentType, state, options) {
    try {
        const ctId = state.currentCT || "unknown";
        const traceDir = join(TRACES_DIR, ctId);
        mkdirSync(traceDir, { recursive: true });
        // Use spawnedAt as filename key for consistency between start/end
        const spawnTs = state.subAgentStates?.[agentType]?.spawnedAt || Date.now();
        const traceFile = join(traceDir, `run-${spawnTs}.jsonl`);
        const opts = options || {};
        const evtType = opts.event || "end"; // default to end for backward compat
        const reconciled = opts.reconciled || false;
        if (evtType === "start") {
            // Pre-write sparse trace at spawn time
            const traceEvent = {
                event: "start",
                stage: agentType,
                ts: new Date().toISOString(),
                agentId: (event.agentId || ""),
                taskName: (event.taskName || ""),
                ct: ctId,
                contract: state.activeContract || "",
                state: state.state,
                stdout: "",
                stderr: "",
                text: "",
                success: null, // unknown at spawn time
            };
            appendFileSync(traceFile, JSON.stringify(traceEvent) + "\n", "utf-8");
            console.log(`[harness-hooks] trace pre-written: ${traceFile}`);
        }
        else {
            // Append end trace (full data from subagent result)
            const result = event.result || {};
            const traceEvent = {
                event: "end",
                stage: agentType,
                ts: new Date().toISOString(),
                agentId: event.agentId || "",
                taskName: event.taskName || "",
                ct: ctId,
                contract: state.activeContract || "",
                state: state.state,
                stdout: (result.stdout || "").slice(0, 5000),
                stderr: (result.stderr || "").slice(0, 2000),
                text: (result.text || "").slice(0, 5000),
                toolCalls: (result.toolCalls || []).length > 0 ? result.toolCalls.slice(0, 50) : undefined,
                error: result.error || undefined,
                success: result.success !== false,
                duration: state.subAgentStates?.[agentType]?.spawnedAt
                    ? Date.now() - state.subAgentStates[agentType].spawnedAt
                    : undefined,
                reconciled: reconciled || undefined,
            };
            appendFileSync(traceFile, JSON.stringify(traceEvent) + "\n", "utf-8");
            console.log(`[harness-hooks] trace appended: ${traceFile}${reconciled ? " (reconciled)" : ""}`);
        }
    }
    catch (e) {
        console.log(`[harness-hooks] trace dump error: ${e.message?.slice(0, 80)}`);
    }
}
// CT-01: Initialize SPECS_DIR on module startup
mkdirSync(SPECS_DIR, { recursive: true });
// ── before_prompt_build pure helpers（P1-split-hook1：等价行为，不碰状态机流）──
function isResumeRetryCommand(text) {
    return /继续|继续执行|resume|continue|retry|重试/.test(text);
}
function parseReviewVerdict(reportFile) {
    if (!existsSync(reportFile))
        return null;
    try {
        const head = readFileSync(reportFile, "utf-8").split("\n").slice(0, 30).join("\n");
        return {
            isAccept: /\*\*ACCEPT\*\*|verdict.*accept/i.test(head),
            isRevise: /\*\*REVISE\*\*|verdict.*revise/i.test(head),
            isBlocked: /\*\*BLOCKED\*\*|verdict.*blocked/i.test(head),
        };
    }
    catch {
        return null;
    }
}
function buildLongTaskGrillInject() {
    return [
        `[ROUTE: LONG task → grill-first → draft_contract]`,
        `[第一步：加载 skills/grill-me/SKILL.md，对用户意图做否证质疑]`,
        `[质疑重点：`,
        `  1. 这个合约该存在吗？（删除不增加核心价值的）`,
        `  2. 有更简单的路径吗？（不用合约？1 个 CT 够？）`,
        `  3. AC 能机器验证吗？`,
        `  4. 约束/回滚/边界声明了吗？`,
        `  5. CT 依赖关系对吗？能并行吗？]`,
        `[质疑完成 → 输出 GRILL_VERDICT: READY / REWORK / KILL]`,
        `[第二步：GRILL verdict = READY → 加载 skills/lc-drafter/SKILL.md 生成合约]`,
        `[禁止跳过 grill 直接 draft]`,
    ];
}
function isStaleSubagent(info, now, staleMs = 60000) {
    return !!(info && info.spawnedAt && !info.doneAt && (now - info.spawnedAt) > staleMs && now > info.spawnedAt);
}
// ═══════════════════════════════════════════════════════
// Hook Entry
// ═══════════════════════════════════════════════════════
export default definePluginEntry({
    id: "harness-hooks",
    name: "Harness Hooks",
    description: "CT 验证 + 合约上下文注入 + intentParser统一路由 + actionGate行为校验 + auditLog状态基线 + JSON安全配置 + 自动化测试",
    register(api) {
        // ─── Hook 1: before_prompt_build ───────────────────
        api.on("before_prompt_build", async (event, ctx) => {
            const state = loadState();
            const userPrompt = event.prompt || JSON.stringify(event.messages || "");
            // ── CT-01: Unified intent parsing ──
            const intent = intentParser(userPrompt, state.state);
            if (intent.confidence >= 0.7 && intent.intent_type !== "unknown") {
                // Only store intent for action gate when in a contract-relevant state
                // Avoids memory_flush/system prompts being classified and blocking tools
                if (["LC_ACTIVE", "CT_RUNNING", "SPEC_REVIEW", "QUALITY_REVIEW", "INTEGRATION_VERIFY", "ARBITER_BLOCKED"].includes(state.state)) {
                    state.currentIntent = intent;
                    saveState(state);
                }
                console.log(`[harness-hooks] intentParser: type=${intent.intent_type}, target=${intent.target}, confidence=${intent.confidence}, keyword="${intent.matchedKeyword}", sub_intent=${intent.sub_intent}`);
                // CT-02: system_maintenance → inject contract/blind/preflight flow
                if (intent.intent_type === "system_maintenance") {
                    const sub = intent.sub_intent || "general";
                    const preflightResult = runPreflightCheck();
                    const injects = [
                        `[ROUTE: system_maintenance] [sub_intent: ${sub}]`,
                        `[MANDATORY: Gateway预检] 检测到系统维护操作 (${sub})`,
                    ];
                    if (preflightResult === "PASS") {
                        injects.push(`[preflight 通过] 安全检查通过, 可继续执行`);
                    }
                    else {
                        injects.push(`[preflight 不通过 (${preflightResult})] 操作已被拦截。请运行 bash scripts/gateway_preflight.sh 查看详情。`);
                        return { block: true, blockReason: injects.join(" "), prependSystemContext: injects.join("\n") };
                    }
                    return { prependSystemContext: injects.join("\n") };
                }
                // CT-03: harness_validator.py call (after intent parser)
                const validatorResult = USE_ASYNC_VALIDATOR
                    ? await runHarnessValidatorAsync(intent, state, event)
                    : runHarnessValidator(intent, state, event);
                if (validatorResult) {
                    console.log(`[harness-hooks] validator: pass=${validatorResult.pass}, blocks=${validatorResult.blocks?.length || 0}, warnings=${validatorResult.warnings?.length || 0}`);
                    if (validatorResult.blocks && validatorResult.blocks.length > 0) {
                        const injects = [
                            ...(validatorResult.injects || []),
                            ...validatorResult.blocks.map(b => `[HARNESS-BLOCK] ${b}`),
                        ];
                        return { block: true, blockReason: injects.join(" "), prependSystemContext: injects.join("\n") };
                    }
                    if (validatorResult.injects && validatorResult.injects.length > 0) {
                        return { prependSystemContext: [...validatorResult.injects, ...buildRouteInject(intent, intent.matchedKeyword)].join("\n") };
                    }
                }
                // CT-03: Unified inject format
                return { prependSystemContext: buildRouteInject(intent, intent.matchedKeyword).join("\n") };
            }
            // Fallback: confidence < 0.7 → use existing logic below
            // ── MEDIUM+ risk: preflight + warning (CT-03: from JSON config) ──
            const riskInfo = classifyRiskLevel(event);
            const isRisky = riskInfo && (riskInfo.severity === "HIGH" || riskInfo.severity === "MEDIUM");
            if (isRisky) {
                const warning = riskInfo.warning || `[${riskInfo.severity}风险] 检测到 ${riskInfo.reason}`;
                const hasContract = state.state !== "INACTIVE" && state.activeContract;
                let injects = [];
                let shouldBlock = false;
                // Always run preflight for preflight-required patterns
                if (riskInfo.preflight) {
                    injects.push(warning);
                    injects.push(`[正在运行 gateway_preflight 检查...]`);
                    const pf = runPreflightCheck();
                    if (pf === "PASS") {
                        injects.push(`[preflight 通过] ${riskInfo.reason} — 已通过安全检查, 继续执行。`);
                        console.log(`[harness-hooks] ${riskInfo.severity} risk allowed — preflight PASS`);
                    }
                    else {
                        injects.push(`[preflight 不通过 (${pf})] 操作已被拦截。请修复问题后重试: 运行 bash scripts/gateway_preflight.sh 查看详情。`);
                        console.log(`[harness-hooks] ${riskInfo.severity} risk blocked — preflight ${pf}`);
                        shouldBlock = true;
                    }
                }
                else {
                    // No preflight, just warn
                    injects.push(warning);
                    injects.push(`[请确认 ${riskInfo.reason} 是否安全, 确保已做好回滚准备]`);
                }
                if (shouldBlock) {
                    return { block: true, blockReason: injects.join(" "), prependSystemContext: injects.join("\n") };
                }
                // Preflight passed or no preflight needed — inject warning + allow
                return { prependSystemContext: injects.join("\n") };
            }
            // ── Task length classification → route LONG tasks to grill-first → contract ──
            const taskLength = classifyTaskLength(event);
            if (taskLength === "LONG" && state.state === "INACTIVE" && state.activeContract) {
                console.log(`[harness-hooks] LONG task detected — route to grill-first → contract`);
                return { prependSystemContext: buildLongTaskGrillInject().join("\n") };
            }
            // Auto-normalize: running state with no active contract → INACTIVE
            if (state.state !== "INACTIVE" && state.state !== "LC_DONE" && state.state !== "STOPPED" && !state.activeContract) {
                transitionState(state, "INACTIVE", `auto-normalize: no active contract (was ${state.state})`);
                state.currentCT = null;
                state.ctSequence = [];
                state.completedCTs = [];
                state.currentIntent = null;
                state.lastSeenLC = null;
                saveState(state);
                console.log(`[harness-hooks] auto-normalized: ${state.state} → INACTIVE (no active contract)`);
            }
            // Auto-detect new LC files
            if (state.state === "INACTIVE" || state.state === "CT_RUNNING" || state.state === "SPEC_REVIEW" || state.state === "QUALITY_REVIEW" || state.state === "LC_DONE" || state.state === "STOPPED" || state.state === "LC_ACTIVE") {
                checkLCActivation(state);
            }
            // ── Gap 2A fix: scan artifacts/ for review reports → auto-set passedAt/failedAt ──
            // Detects review results from manually spawned subagents that hooks don't track
            {
                const ctId = state.currentCT || "";
                const reportFile = join(homedir(), ".openclaw", "workspace", "artifacts", "code-reviewer", ctId, "review-report.md");
                const verdict = parseReviewVerdict(reportFile);
                if (verdict) {
                    const { isAccept, isRevise, isBlocked } = verdict;
                    if (state.state === "SPEC_REVIEW" && state.subAgentStates?.spec_reviewer && !state.subAgentStates.spec_reviewer.passedAt && !state.subAgentStates.spec_reviewer.failedAt) {
                        if (isAccept) {
                            state.subAgentStates.spec_reviewer.passedAt = Date.now();
                            state.subAgentStates.spec_reviewer.doneAt = Date.now();
                            console.log(`[harness-hooks] gap2a: spec_reviewer.passedAt auto-set from review report`);
                            saveState(state);
                        }
                        else if (isRevise || isBlocked) {
                            state.subAgentStates.spec_reviewer.failedAt = Date.now();
                            state.subAgentStates.spec_reviewer.doneAt = Date.now();
                            console.log(`[harness-hooks] gap2a: spec_reviewer.failedAt auto-set from review report`);
                            saveState(state);
                        }
                    }
                    if (state.state === "QUALITY_REVIEW" && state.subAgentStates?.quality_reviewer && !state.subAgentStates.quality_reviewer.passedAt && !state.subAgentStates.quality_reviewer.failedAt) {
                        if (isAccept) {
                            state.subAgentStates.quality_reviewer.passedAt = Date.now();
                            state.subAgentStates.quality_reviewer.doneAt = Date.now();
                            console.log(`[harness-hooks] gap2a: quality_reviewer.passedAt auto-set from review report`);
                            saveState(state);
                        }
                        else if (isRevise || isBlocked) {
                            state.subAgentStates.quality_reviewer.failedAt = Date.now();
                            state.subAgentStates.quality_reviewer.doneAt = Date.now();
                            console.log(`[harness-hooks] gap2a: quality_reviewer.failedAt auto-set from review report`);
                            saveState(state);
                        }
                    }
                }
            }
            // ── Auto-advance + spawn instruction injection ──
            // After transitioning state, return spawn instruction so the agent acts immediately
            const ctxContract = state.activeContract || "未知合约";
            const ctxCT = state.currentCT || "无";
            if ((state.state === "LC_ACTIVE" || state.state === "CT_RUNNING") && state.subAgentStates?.coder?.handoffDone) {
                const coderState = state.subAgentStates.coder;
                if (!coderState.doneAt) {
                    coderState.doneAt = Date.now();
                    console.log(`[harness-hooks] auto-advance: setting coder.doneAt=${coderState.doneAt}`);
                }
                if (state.state !== "SPEC_REVIEW") {
                    transitionState(state, "SPEC_REVIEW", "coder handoff detected (auto-advance)");
                    appendAuditLog(state, { type: "handoff", agent: "coder", tool: "before_prompt_build", target: "auto-advance", result: "ok" });
                    saveState(state);
                    return { prependSystemContext: `[STATE: coder handoff 已完成 | 合约: ${ctxContract} | CT: ${ctxCT}]\n[必须执行 skills/auto-spawn/SKILL.md → spawn spec_reviewer]` };
                }
            }
            if (state.state === "SPEC_REVIEW" && state.subAgentStates?.spec_reviewer?.passedAt) {
                transitionState(state, "QUALITY_REVIEW", "spec_reviewer passed (auto-advance)");
                appendAuditLog(state, { type: "handoff", agent: "spec_reviewer", tool: "before_prompt_build", target: "auto-advance", result: "ok" });
                saveState(state);
                return { prependSystemContext: `[STATE: spec review 已完成 | 合约: ${ctxContract} | CT: ${ctxCT}]\n[必须执行 skills/auto-spawn/SKILL.md → spawn quality_reviewer]` };
            }
            if (state.state === "SPEC_REVIEW" && state.subAgentStates?.spec_reviewer?.failedAt) {
                transitionState(state, "ARBITER_BLOCKED", "spec_reviewer failed (auto-advance)");
                saveState(state);
                return { prependSystemContext: `[STATE: spec review KNOCKED | 合约: ${ctxContract} | CT: ${ctxCT}]\n[spec review failed，需要人工决策]` };
            }
            if (state.state === "QUALITY_REVIEW" && state.subAgentStates?.quality_reviewer?.passedAt) {
                // ── Verify gate: run deterministic checks before advancing ──
                if (!state.subAgentStates?.verify?.passedAt && !state.subAgentStates?.verify?.failedAt) {
                    const verifyResult = runContractVerify(state);
                    if (verifyResult.passed) {
                        state.subAgentStates.verify = { passedAt: Date.now(), failedAt: null, result: verifyResult.summary };
                        saveState(state);
                        console.log(`[harness-hooks] VERIFY PASSED for ${ctxCT}: ${verifyResult.summary}`);
                        appendAuditLog(state, { type: "verify_passed", agent: "main", tool: "before_prompt_build", target: ctxCT, result: verifyResult.summary });
                    }
                    else {
                        state.subAgentStates.verify = { passedAt: null, failedAt: Date.now(), result: verifyResult.summary };
                        saveState(state);
                        console.log(`[harness-hooks] VERIFY FAILED for ${ctxCT}: ${verifyResult.summary}`);
                        appendAuditLog(state, { type: "verify_failed", agent: "main", tool: "before_prompt_build", target: ctxCT, result: verifyResult.summary });
                        return { prependSystemContext: [
                                `[VERIFY FAILED | 合约: ${ctxContract} | CT: ${ctxCT}]`,
                                `[确定性检查未通过：${verifyResult.summary}]`,
                                `[fix后，需在合约中执行 verify 字段中的检查，全部通过后 CT 才算完成]`,
                            ].join("\n") };
                    }
                }
                // ⚠️ If verify previously failed, keep blocking - support retry
                if (state.subAgentStates?.verify?.failedAt) {
                    const userText = userPrompt.toLowerCase();
                    if (isResumeRetryCommand(userText)) {
                        // Reset verify state and re-run
                        state.subAgentStates.verify = { passedAt: null, failedAt: null, result: null };
                        saveState(state);
                        const verifyResult = runContractVerify(state);
                        if (verifyResult.passed) {
                            state.subAgentStates.verify = { passedAt: Date.now(), failedAt: null, result: verifyResult.summary };
                            saveState(state);
                            console.log(`[harness-hooks] VERIFY PASSED (retry) for ${ctxCT}: ${verifyResult.summary}`);
                            appendAuditLog(state, { type: "verify_passed", agent: "main", tool: "before_prompt_build", target: ctxCT, result: verifyResult.summary });
                        }
                        else {
                            state.subAgentStates.verify = { passedAt: null, failedAt: Date.now(), result: verifyResult.summary };
                            saveState(state);
                            console.log(`[harness-hooks] VERIFY FAILED (retry) for ${ctxCT}: ${verifyResult.summary}`);
                            appendAuditLog(state, { type: "verify_failed", agent: "main", tool: "before_prompt_build", target: ctxCT, result: verifyResult.summary });
                            return { prependSystemContext: [
                                    `[VERIFY FAILED (重试) | 合约: ${ctxContract} | CT: ${ctxCT}]`,
                                    `[确定性检查未通过：${verifyResult.summary}]`,
                                    `[修复后输入"继续"或"重试"重新验证]`,
                                ].join("\n") };
                        }
                    }
                    else {
                        return { prependSystemContext: [
                                `[VERIFY FAILED | 合约: ${ctxContract} | CT: ${ctxCT}]`,
                                `[确定性检查未通过：${state.subAgentStates.verify.result}]`,
                                `[修复后输入"继续"或"重试"重新验证]`,
                            ].join("\n") };
                    }
                }
                if (state.currentCT && !state.completedCTs.includes(state.currentCT)) {
                    state.completedCTs.push(state.currentCT);
                }
                // Advance to next CT + reset subAgentStates for next cycle
                const nextCT = state.ctSequence?.find(c => !state.completedCTs?.includes(c));
                if (nextCT) {
                    state.currentCT = nextCT;
                    state.subAgentStates = JSON.parse(JSON.stringify(getDefaultSubAgentStates()));
                    transitionState(state, "LC_ACTIVE", `quality_reviewer passed → next CT ${nextCT}`);
                }
                else {
                    // ── Integration verify: run end-to-end before declaring contract complete ──
                    const ivContractPath = findContractFilePath(state);
                    const ivCmds = ivContractPath ? extractIntegrationVerifyCommands(ivContractPath) : [];
                    if (ivCmds.length > 0) {
                        transitionState(state, "INTEGRATION_VERIFY", "all CTs done, running integration verify");
                        state.integrationVerify = { passedAt: null, failedAt: null, result: null };
                        saveState(state);
                        return { prependSystemContext: [
                                `[INTEGRATION VERIFY | 合约: ${ctxContract}]`,
                                `[所有 CT 已完成，正在运行端到端验证]`,
                                `[运行中，请等待结果...]`,
                            ].join("\n") };
                    }
                    // No integration verify commands → use advanceToNextCT for consistent cleanup
                    advanceToNextCT(state);
                }
                saveState(state);
                return { prependSystemContext: `[STATE: CT ${ctxCT} 完成 | 合约: ${ctxContract} | 已完成的CT: ${state.completedCTs.join(", ")}]\n[${nextCT ? "下一个CT: " + nextCT : "所有CT已完成，合约收口"}]` };
            }
            // ── P1 fix: SUSPECTED_STUCK recovery on user "继续" ──
            if (state.state === "SUSPECTED_STUCK") {
                const userText = userPrompt.toLowerCase();
                if (/继续|继续执行|resume|continue|recover|proceed/.test(userText)) {
                    console.log(`[harness-hooks] SUSPECTED_STUCK recovery: user said "${userText.slice(0, 30)}" → resetting all state, transitioning to CT_RUNNING`);
                    state.modelFailures = 0;
                    state.modelTier = 0;
                    state.consecutiveEmptyResponses = 0;
                    state.retryCount = 0;
                    state.successfulCalls = 0;
                    state.modelHistory = [];
                    state.currentIntent = null; // clear stale intent for action gate
                    state.subAgentStates = JSON.parse(JSON.stringify(getDefaultSubAgentStates())); // reset timestamps
                    transitionState(state, "CT_RUNNING", "user resume from SUSPECTED_STUCK");
                    appendAuditLog(state, {
                        type: "resume",
                        agent: "main",
                        tool: "before_prompt_build",
                        target: "SUSPECTED_STUCK→CT_RUNNING",
                        result: "recovered",
                    });
                    saveState(state);
                    const ctName = state.currentCT || "CT-01";
                    const contractName = state.activeContract || "unknown";
                    const resumeInject = [
                        `[SUSPECTED_STUCK 恢复] 用户请求继续执行`,
                        `[合约: ${contractName} | CT: ${ctName} | 状态: CT_RUNNING]`,
                        `[计数器已重置: modelFailures=0, modelTier=0, retryCount=0]`,
                    ];
                    return { prependSystemContext: resumeInject.join("\n") };
                }
            }
            // ── INTEGRATION_VERIFY: run end-to-end smoke test after all CTs ──
            if (state.state === "INTEGRATION_VERIFY") {
                const ivPath = findContractFilePath(state);
                const ivCmds = ivPath ? extractIntegrationVerifyCommands(ivPath) : [];
                if (state.integrationVerify?.passedAt) {
                    // Already passed → finalize
                    advanceToNextCT(state);
                    saveState(state);
                    return { prependSystemContext: `[STATE: INTEGRATION VERIFY PASSED | 合约: ${ctxContract}]\n[所有端到端检查通过，合约完成]` };
                }
                if (state.integrationVerify?.failedAt) {
                    // Previously failed → check for retry command
                    const userText = userPrompt.toLowerCase();
                    if (isResumeRetryCommand(userText)) {
                        const result = runIntegrationVerify(ivCmds);
                        if (result.passed) {
                            state.integrationVerify = { passedAt: Date.now(), failedAt: null, result: result.summary };
                            saveState(state);
                            console.log(`[harness-hooks] INTEGRATION VERIFY PASSED (retry) for ${ctxContract}`);
                            appendAuditLog(state, { type: "integration_verify_passed", agent: "main", tool: "before_prompt_build", target: ctxContract, result: result.summary });
                            advanceToNextCT(state);
                            saveState(state);
                            return { prependSystemContext: `[STATE: INTEGRATION VERIFY PASSED (重试通过) | 合约: ${ctxContract}]\n[端到端检查通过，合约完成]` };
                        }
                        else {
                            state.integrationVerify = { passedAt: null, failedAt: Date.now(), result: result.summary };
                            saveState(state);
                            console.log(`[harness-hooks] INTEGRATION VERIFY FAILED (retry) for ${ctxContract}: ${result.summary}`);
                            appendAuditLog(state, { type: "integration_verify_failed", agent: "main", tool: "before_prompt_build", target: ctxContract, result: result.summary });
                            return { prependSystemContext: [
                                    `[INTEGRATION VERIFY FAILED (重试) | 合约: ${ctxContract}]`,
                                    `[端到端检查未通过：${result.summary}]`,
                                    `[修复后输入"继续"或"重试"重新验证]`,
                                ].join("\n") };
                        }
                    }
                    return { prependSystemContext: [
                            `[INTEGRATION VERIFY FAILED | 合约: ${ctxContract}]`,
                            `[端到端检查未通过：${state.integrationVerify.result}]`,
                            `[修复问题后输入"继续"或"重试"重新验证]`,
                        ].join("\n") };
                }
                // First entry → run integration verify now
                if (ivCmds.length > 0) {
                    const result = runIntegrationVerify(ivCmds);
                    if (result.passed) {
                        state.integrationVerify = { passedAt: Date.now(), failedAt: null, result: result.summary };
                        saveState(state);
                        console.log(`[harness-hooks] INTEGRATION VERIFY PASSED for ${ctxContract}: ${result.summary}`);
                        appendAuditLog(state, { type: "integration_verify_passed", agent: "main", tool: "before_prompt_build", target: ctxContract, result: result.summary });
                        advanceToNextCT(state);
                        saveState(state);
                        return { prependSystemContext: `[STATE: INTEGRATION VERIFY PASSED | 合约: ${ctxContract}]\n[所有端到端检查通过，合约完成]` };
                    }
                    else {
                        state.integrationVerify = { passedAt: null, failedAt: Date.now(), result: result.summary };
                        saveState(state);
                        console.log(`[harness-hooks] INTEGRATION VERIFY FAILED for ${ctxContract}: ${result.summary}`);
                        appendAuditLog(state, { type: "integration_verify_failed", agent: "main", tool: "before_prompt_build", target: ctxContract, result: result.summary });
                        return { prependSystemContext: [
                                `[INTEGRATION VERIFY FAILED | 合约: ${ctxContract}]`,
                                `[端到端检查未通过：${result.summary}]`,
                                `[修复后输入"继续"或"重试"重新验证]`,
                            ].join("\n") };
                    }
                }
                // No integration verify commands → finalize directly
                advanceToNextCT(state);
                saveState(state);
                return { prependSystemContext: `[STATE: INTEGRATION VERIFY SKIPPED | 合约: ${ctxContract}]\n[合约已完整执行]` };
            }
            // ── Layer 3: Trace reconciliation ──
            // For subagents with spawnedAt set but no doneAt and >60s stale,
            // check if a trace file already exists. If not, dump a reconciled trace.
            if (state.subAgentStates) {
                const now = Date.now();
                const SIXTY_SEC = 60000;
                for (const [type, info] of Object.entries(state.subAgentStates)) {
                    if (isStaleSubagent(info, now, SIXTY_SEC)) {
                        const ctId = state.currentCT || "unknown";
                        const traceFile = join(TRACES_DIR, ctId, `run-${info.spawnedAt}.jsonl`);
                        // Only reconcile if no trace file exists (no start written yet)
                        if (!existsSync(traceFile)) {
                            console.log(`[harness-hooks] reconciliation: ${type} spawned at ${info.spawnedAt} >60s without trace — dumping reconciled trace`);
                            const reconciledEvent = { agentId: "", taskName: info.taskName || "", result: {} };
                            dumpTraceJsonl(reconciledEvent, type, state, { event: "end", reconciled: true });
                            info.doneAt = now;
                            appendAuditLog(state, {
                                type: "reconciled",
                                agent: type,
                                tool: "before_prompt_build",
                                target: ctId,
                                result: "reconciled",
                            });
                            saveState(state);
                        }
                    }
                }
            }
            // ── Auto-Spawn V2: hard constraint injection (CT-02: auditLog-based) ──
            if (shouldTriggerSpawn(state)) {
                console.log(`[harness-hooks] auto-spawn-v2: trigger detected via auditLog/subAgentStates`);
                const ctxContract = state.activeContract || "未知合约";
                const ctxCT = state.currentCT || "无";
                return {
                    prependSystemContext: [
                        `[STATE: coder handoff 已完成 | 合约: ${ctxContract} | CT: ${ctxCT}]`,
                        `[你必须执行 skills/auto-spawn/SKILL.md 的决策树 → spawn reviewer，禁止跳过]`,
                    ].join("\n"),
                };
            }
            // Inject contract context
            if (state.state !== "INACTIVE" && state.activeContract) {
                const injects = [
                    `[当前合约: ${state.activeContract} | 当前CT: ${state.currentCT || "无"} | 状态: ${state.state}]`,
                ];
                // CT-02: Inject trace path hint when active CT present
                if (state.currentCT) {
                    injects.push(`[可用轨迹: grep -r '关键词' scripts/traces/CT-*]`);
                }
                const modelCtx = buildModelRoutingContext(state);
                if (modelCtx.length > 0)
                    injects.push(...modelCtx);
                if (state.modelTier === 0 && isComplexTask(event)) {
                    state.modelTier = getModelTiers().length - 1;
                    state.modelHistory = state.modelHistory || [];
                    state.modelHistory.push({
                        tier: 0, model: getModelTiers()[0].label, timestamp: Date.now(),
                        reason: "complex task detected, auto-escalate to DeepSeek Pro",
                    });
                    injects.push(`[model-routing: complex task detected — use DeepSeek Pro]`);
                    console.log(`[harness-hooks] complex task → DeepSeek Pro (auto-escalate)`);
                    saveState(state);
                }
                // Inject QMD priority routing guidance
                injects.push(MEMORY_ROUTING_INJECT);
                console.log(`[harness-hooks] 当前合约: ${state.activeContract} | CT: ${state.currentCT || "无"} | 状态: ${state.state} | 模型: ${getCurrentModel(state).label}`);
                return { prependSystemContext: injects.join("\n") };
            }
            // Inject QMD priority routing guidance (non-contract fallback)
            return { prependSystemContext: MEMORY_ROUTING_INJECT };
        }, { priority: 50 });
        // ─── Hook 2: before_tool_call ─────────────────────
        api.on("before_tool_call", async (event, ctx) => {
            const state = loadState();
            // ── RESTART-PREFLIGHT GATE (hardcoded, runs before all other checks) ──
            const restartGate = checkRestartPreflightGate(event);
            if (restartGate) {
                if (restartGate.block) {
                    console.log(`[harness-hooks] RESTART-PREFLIGHT GATE: blocked`);
                    return { block: true, blockReason: restartGate.blockReason, prependSystemContext: restartGate.inject.join("\n") };
                }
                // preflight passed — inject pass message
                return { prependSystemContext: restartGate.inject.join("\n") };
            }
            // ── CT-01: Soul Gate evaluation on tool calls ──
            const toolParams = JSON.stringify(event.params || {});
            const soulGateOptions = isSkillWorkshopProposalCreation(event)
                ? { skipGateIds: ["soul-no-self-modification"] }
                : {};
            const soulResult = evaluateSoulGates(toolParams, state, soulGateOptions);
            if (soulResult.blocks.length > 0) {
                console.log(`[harness-hooks] soul-gate BLOCK: ${soulResult.blocks.map(b => b.gate).join(", ")}`);
                saveState(state);
                return { block: true, blockReason: soulResult.blocks.map(b => b.reason).join(" ") };
            }
            if (soulResult.injects.length > 0) {
                saveState(state);
                return { prependSystemContext: soulResult.injects.join("\n") };
            }
            // ── CT-02: Action Gate — check intent vs tool ──
            const sessionId = event.context?.sessionId || "default";
            if (state.currentIntent && state.currentIntent.intent_type !== "unknown" && ["CT_RUNNING", "SPEC_REVIEW", "QUALITY_REVIEW", "ARBITER_BLOCKED"].includes(state.state)) {
                const gateResult = checkActionGate(state.currentIntent, event.toolName, sessionId);
                if (gateResult) {
                    console.log(`[harness-hooks] actionGate: ${state.currentIntent.intent_type} expects ${INTENT_TOOL_SETS[state.currentIntent.target]?.description}, got ${event.toolName}`);
                    if (gateResult.block) {
                        return { block: true, blockReason: gateResult.blockReason };
                    }
                    if (gateResult.inject) {
                        return { prependSystemContext: gateResult.inject.join("\n") };
                    }
                }
            }
            // ── CT format validation on draft_lc ──
            if (event.toolName === "draft_lc") {
                const cts = event.params?.ct;
                if (!Array.isArray(cts)) {
                    return {
                        block: true,
                        blockReason: "ct 必须为数组",
                    };
                }
                const CT_PARTS = 7;
                for (const ct of cts) {
                    if (typeof ct !== "string" || ct.split("|").length !== CT_PARTS) {
                        return {
                            block: true,
                            blockReason: `CT 格式错误: "${ct}"。应为 ${CT_PARTS} 段（CT-ID|标题|等级|依赖|Builder|Reviewer|风险）`,
                        };
                    }
                }
            }
            // ── LC_ACTIVE → CT_RUNNING on user confirm ──
            if (state.state === "LC_ACTIVE" && state.ctSequence.length > 0) {
                const confirmTools = ["confirm_write"];
                if (confirmTools.includes(event.toolName)) {
                    transitionState(state, "CT_RUNNING", `user action: ${event.toolName}`);
                    saveState(state);
                }
            }
            // ── CT-02: Audit log entry (before) ──
            appendAuditLog(state, {
                type: "tool_call",
                agent: event.context?.agentId || "main",
                tool: event.toolName,
                target: event.params?.path || event.params?.agentId || "",
                result: "pending",
                toolCallId: event.toolCallId || ctx?.toolCallId || "",
            });
            saveState(state);
            return;
        }, { priority: 50 });
        // ─── Hook 2.5: subagent_spawned ─────────────────
        api.on("subagent_spawned", async (event, ctx) => {
            const state = loadState();
            // Infer agentType from agentId or taskName (via config)
            const agentId = (event.agentId || "").toLowerCase();
            const taskName = (event.taskName || "").toLowerCase();
            const combined = agentId + " " + taskName;
            let agentType = inferAgentTypeFromConfig(combined);
            // Fallback: default to coder for spawns from main agent
            if (!agentType && /^main/.test(agentId)) {
                agentType = "coder";
                console.log(`[harness-hooks] subagent_spawned: fallback to coder (agentId=${JSON.stringify(event.agentId)})`);
            }
            if (!agentType) {
                console.log(`[harness-hooks] subagent_spawned: could not infer agentType from "${combined}"`);
                saveState(state);
                return;
            }
            if (!state.subAgentStates?.coder) {
                state.subAgentStates = JSON.parse(JSON.stringify(getDefaultSubAgentStates()));
            }
            // P0 fix: don't overwrite spawnedAt if subagent already completed (doneAt set)
            if (state.subAgentStates[agentType].doneAt && state.subAgentStates[agentType].spawnedAt) {
                console.log(`[harness-hooks] subagent_spawned: ${agentType} already completed at ${state.subAgentStates[agentType].doneAt}, skipping overwrite`);
                saveState(state);
                return;
            }
            state.subAgentStates[agentType].spawnedAt = Date.now();
            state.subAgentStates[agentType].taskName = event.taskName || "";
            appendAuditLog(state, {
                type: "subagent_spawned",
                agent: agentType,
                tool: "subagent_spawned",
                target: event.agentId || "",
                result: "ok",
            });
            console.log(`[harness-hooks] subagent_spawned: type=${agentType}, agentId=${event.agentId}, task=${event.taskName}`);
            // Layer 1: pre-write trace at spawn time (even if ended never fires)
            dumpTraceJsonl(event, agentType, state, { event: "start" });
            if (event.childSessionKey) {
                spawnedSessionKeys.add(event.childSessionKey);
                console.log(`[harness-hooks] tracking spawned session: ${event.childSessionKey}`);
            }
            saveState(state);
        }, { priority: 50 });
        // ─── Hook 2.6a: message_sending / suppress subagent ──
        api.on("message_sending", async (event, ctx) => {
            if (ctx.sessionKey && spawnedSessionKeys.has(ctx.sessionKey)) {
                console.log(`[harness-hooks] suppressing spawned session response: ${ctx.sessionKey}`);
                return { cancel: true, cancelReason: "spawned_session_suppressed" };
            }
        }, { priority: 100 });
        // ─── Hook 2.6: subagent_ended ─────────────────────
        api.on("subagent_ended", async (event, ctx) => {
            const state = loadState();
            // Infer agentType (via config)
            const agentId = (event.agentId || "").toLowerCase();
            const taskName = (event.taskName || "").toLowerCase();
            const combined = agentId + " " + taskName;
            let agentType = inferAgentTypeFromConfig(combined);
            // Fallback 1: match agentId containing "main"
            if (!agentType && /main/.test(agentId)) {
                agentType = "coder";
                console.log(`[harness-hooks] subagent_ended: fallback to coder via agentId (agentId=${JSON.stringify(event.agentId)})`);
            }
            // Fallback 2: check subAgentStates for pending spawn (spawnedAt set, no doneAt)
            if (!agentType && state.subAgentStates) {
                for (const [type, info] of Object.entries(state.subAgentStates)) {
                    if (info && info.spawnedAt && !info.doneAt) {
                        agentType = type;
                        console.log(`[harness-hooks] subagent_ended: fallback to ${type} via pending subAgentStates`);
                        break;
                    }
                }
            }
            if (!agentType) {
                console.log(`[harness-hooks] subagent_ended: could not infer agentType from "${combined}"`);
                // ── CT-02: dump trace even for unknown agent types ──
                dumpTraceJsonl(event, agentType || "unknown", state, { event: "end" });
                saveState(state);
                return;
            }
            if (!state.subAgentStates?.coder) {
                state.subAgentStates = JSON.parse(JSON.stringify(getDefaultSubAgentStates()));
            }
            // P0 fix: timestamp sanity — skip doneAt if spawnedAt is in the future (clock skew)
            const _endTs = Date.now();
            if (state.subAgentStates[agentType].spawnedAt && _endTs < state.subAgentStates[agentType].spawnedAt) {
                console.warn(`[harness-hooks] subagent_ended: timestamp inversion for ${agentType} (spawnedAt=${state.subAgentStates[agentType].spawnedAt} > now=${_endTs}), skipping doneAt`);
            }
            else {
                state.subAgentStates[agentType].doneAt = _endTs;
            }
            appendAuditLog(state, {
                type: "subagent_ended",
                agent: agentType,
                tool: "subagent_ended",
                target: event.agentId || "",
                result: "ok",
            });
            console.log(`[harness-hooks] subagent_ended: type=${agentType}, agentId=${event.agentId}`);
            // coder ended + handoff.md exists → SPEC_REVIEW
            if (agentType === "coder") {
                // P0 fix: broaden handoff search to include handoffs/ and artifacts/ directories
                const BASE_HANDOFF_DIR = join(homedir(), ".openclaw", "workspace", "projects", "agent-team-orchestration", "shared");
                const handoffPaths = [
                    event.handoffPath,
                    join(BASE_HANDOFF_DIR, "handoff.md"),
                    join(BASE_HANDOFF_DIR, "handoffs", state.currentCT || "", "handoff.md"),
                ];
                // Also scan handoffs/ and artifacts/ dirs for any handoff.md
                let foundHandoff = false;
                for (const dir of ["handoffs", "artifacts"]) {
                    const searchDir = join(BASE_HANDOFF_DIR, dir);
                    try {
                        const entries = readdirSync(searchDir, { recursive: true });
                        for (const f of entries) {
                            if (f.endsWith("handoff.md")) {
                                handoffPaths.push(join(searchDir, f));
                            }
                        }
                    }
                    catch { /* dir not found */ }
                }
                for (const hp of handoffPaths) {
                    if (hp && existsSync(hp)) {
                        foundHandoff = true;
                        state.subAgentStates.coder.handoffDone = true;
                        state.subAgentStates.coder.handoffAt = Date.now();
                        appendAuditLog(state, {
                            type: "handoff",
                            agent: "coder",
                            tool: "subagent_ended",
                            target: hp,
                            result: "ok",
                        });
                        console.log(`[harness-hooks] subagent_ended: coder handoff found at ${hp}`);
                        if (state.state !== "SPEC_REVIEW") {
                            transitionState(state, "SPEC_REVIEW", `coder ended + handoff.md exists`);
                        }
                        break;
                    }
                }
                if (!foundHandoff) {
                    console.log(`[harness-hooks] subagent_ended: coder ended but no handoff.md found in any known location`);
                }
            }
            // spec_reviewer ended → if PASS transition to QUALITY_REVIEW
            if (agentType === "spec_reviewer") {
                // Check if spec review passed (based on subagent result or output pattern)
                const resultOutput = (event.result?.stdout || event.result?.text || "").toLowerCase();
                const specPassed = /spec_pass|✅|all.*spec|合规.*通过|spec.*compliant/i.test(resultOutput);
                if (specPassed) {
                    state.subAgentStates.spec_reviewer.passedAt = Date.now();
                    if (state.state !== "QUALITY_REVIEW") {
                        transitionState(state, "QUALITY_REVIEW", `spec review PASS → quality review`);
                    }
                }
                else {
                    state.subAgentStates.spec_reviewer.failedAt = Date.now();
                    // ── Failure Arbiter: classify spec review failure ──
                    const arbReportText = event.result?.stdout || event.result?.text || "";
                    const arbContractPath = state.activeContract ? join(CONTRACTS_DIR, state.activeContract) : undefined;
                    const arbCtid = state.currentCT || "unknown";
                    const arbiterResult = USE_ASYNC_ARBITER
                        ? await callArbiterAsync("SPEC_REVIEW", arbReportText, arbContractPath, arbCtid)
                        : callArbiter("SPEC_REVIEW", arbReportText, arbContractPath, arbCtid);
                    state.arbiterResult = arbiterResult;
                    if (!arbiterResult.auto) {
                        // SpecGap/Ambiguity → BLOCKED
                        if (state.state !== "ARBITER_BLOCKED") {
                            transitionState(state, "ARBITER_BLOCKED", `arbiter: ${arbiterResult.classification}`);
                            appendAuditLog(state, {
                                type: "arbiter",
                                agent: agentType,
                                tool: "failure_arbiter",
                                target: "ARBITER_BLOCKED",
                                result: arbiterResult.classification,
                            });
                            console.log(`[harness-hooks] arbiter: ${arbiterResult.classification} → BLOCKED`);
                        }
                    }
                    else {
                        // Bug/Noise → auto-retry
                        console.log(`[harness-hooks] arbiter: ${arbiterResult.classification} → auto-retry`);
                    }
                }
            }
            // quality_reviewer ended → mark sub-task complete
            if (agentType === "quality_reviewer") {
                const resultOutput = (event.result?.stdout || event.result?.text || "").toLowerCase();
                const qualityPassed = /quality_pass|✅|all.*quality|质量.*通过|quality.*approved/i.test(resultOutput);
                if (qualityPassed) {
                    state.subAgentStates.quality_reviewer.passedAt = Date.now();
                    // CT-opt: advance to next CT on quality review pass
                    advanceToNextCT(state);
                    console.log(`[harness-hooks] quality_reviewer: PASSED — advanced CT`);
                }
                else {
                    state.subAgentStates.quality_reviewer.failedAt = Date.now();
                    // ── Failure Arbiter: classify quality review failure ──
                    const arbReportText = event.result?.stdout || event.result?.text || "";
                    const arbContractPath = state.activeContract ? join(CONTRACTS_DIR, state.activeContract) : undefined;
                    const arbCtid = state.currentCT || "unknown";
                    const arbiterResult = USE_ASYNC_ARBITER
                        ? await callArbiterAsync("QUALITY_REVIEW", arbReportText, arbContractPath, arbCtid)
                        : callArbiter("QUALITY_REVIEW", arbReportText, arbContractPath, arbCtid);
                    state.arbiterResult = arbiterResult;
                    if (!arbiterResult.auto) {
                        // SpecGap/Ambiguity → BLOCKED
                        if (state.state !== "ARBITER_BLOCKED") {
                            transitionState(state, "ARBITER_BLOCKED", `arbiter: ${arbiterResult.classification}`);
                            appendAuditLog(state, {
                                type: "arbiter",
                                agent: agentType,
                                tool: "failure_arbiter",
                                target: "ARBITER_BLOCKED",
                                result: arbiterResult.classification,
                            });
                            console.log(`[harness-hooks] arbiter: ${arbiterResult.classification} → BLOCKED`);
                        }
                    }
                    else {
                        // Bug/Noise → auto-retry
                        console.log(`[harness-hooks] arbiter: ${arbiterResult.classification} → auto-retry`);
                    }
                }
            }
            // legacy reviewer ended → mark sub-task review complete + Telegram push
            if (agentType === "reviewer") {
                console.log(`[harness-hooks] reviewer: task completed`);
                // Send verdict to Telegram directly from hooks layer (immune to agent turn failure)
                const resultOutput = event.result?.stdout || event.result?.text || "";
                const verdictMatch = resultOutput.match(/(ACCEPT|REVISE|BLOCKED)/i);
                if (verdictMatch) {
                    const verdict = verdictMatch[1];
                    const contractName = state.activeContract || "unknown";
                    const summary = resultOutput.slice(0, 800).replace(/"/g, '\\"').replace(/'/g, "\\'").replace(/\n/g, " ");
                    // Write sentinel so agent-side cleanup script skips Telegram (dedup)
                    const sentinelPath = join(process.cwd(), ".auto-blind-review", "telegram-sent.json");
                    try {
                        const fsMod = require("fs");
                        const dir = join(process.cwd(), ".auto-blind-review");
                        if (!fsMod.existsSync(dir))
                            fsMod.mkdirSync(dir, { recursive: true });
                        fsMod.writeFileSync(sentinelPath, JSON.stringify({ contract: contractName, verdict, time: Date.now() }));
                    }
                    catch (_) { }
                    const scriptPath = join(homedir(), ".openclaw", "workspace", "scripts", "clean_blind_review_state.py");
                    try {
                        execFileSync("python3", [scriptPath, "--verdict", verdict.match(/(ACCEPT|REVISE|BLOCKED)/i)?.[1] || "", "--contract", contractName], { timeout: 10000, encoding: "utf-8" });
                    }
                    catch (e) {
                        console.log(`[harness-hooks] blind review Telegram push error: ${e.message}`);
                    }
                    // P1 fix: map legacy reviewer verdict to state machine
                    if (verdict.toUpperCase() === "ACCEPT") {
                        state.subAgentStates.reviewer.passedAt = Date.now();
                        appendAuditLog(state, {
                            type: "transition",
                            agent: "reviewer",
                            tool: "subagent_ended",
                            target: "QUALITY_REVIEW",
                            result: "ACCEPT",
                        });
                        if (state.state !== "QUALITY_REVIEW") {
                            transitionState(state, "QUALITY_REVIEW", `reviewer ACCEPT → quality review`);
                        }
                    }
                    else {
                        // REVISE or BLOCKED → ARBITER_BLOCKED
                        state.subAgentStates.reviewer.failedAt = Date.now();
                        const arbReportText = resultOutput;
                        const arbContractPath = state.activeContract ? join(CONTRACTS_DIR, state.activeContract) : undefined;
                        const arbCtid = state.currentCT || "unknown";
                        const arbiterResult = USE_ASYNC_ARBITER
                            ? await callArbiterAsync("REVIEW", arbReportText, arbContractPath, arbCtid)
                            : callArbiter("REVIEW", arbReportText, arbContractPath, arbCtid);
                        state.arbiterResult = arbiterResult;
                        if (!arbiterResult.auto) {
                            if (state.state !== "ARBITER_BLOCKED") {
                                transitionState(state, "ARBITER_BLOCKED", `reviewer ${verdict}: ${arbiterResult.classification}`);
                            }
                        }
                        else {
                            console.log(`[harness-hooks] arbiter: ${arbiterResult.classification} → auto-retry`);
                        }
                    }
                }
            }
            // ── Gap 3A fix: api.inject not available in SDK ──
            // Removed api.inject call (was always failing with "api.inject is not a function")
            // The natural event flow handles triggering: subagent completion → completion event → before_prompt_build fires → auto-advance + gap2A + spawn instruction
            // No manual wake needed.
            // ── CT-02: Dump execution trace to JSONL ──
            dumpTraceJsonl(event, agentType, state, { event: "end" });
            saveState(state);
        }, { priority: 50 });
        // ─── Hook 3: after_tool_call ──────────────────────
        api.on("after_tool_call", async (event, ctx) => {
            const state = loadState();
            // ── CT-02: Audit log update ──
            const pendingAudit = state.auditLog?.find(a => a.result === "pending" && a.tool === event.toolName && (!a.toolCallId || a.toolCallId === (event.toolCallId || ctx?.toolCallId || "")));
            if (pendingAudit) {
                pendingAudit.result = event.result?.success === false ? "error" : "ok";
            }
            // ── Auto-Spawn V2: sessions_spawn detection (via config-based inference) ──
            if (event.toolName === "sessions_spawn") {
                if (!state.subAgentStates?.coder) {
                    state.subAgentStates = JSON.parse(JSON.stringify(getGlobalConfig().defaultSubAgentStates || fallbackSubAgentStates()));
                }
                const params = event.params || {};
                const combined = (params.agentId || "") + " " + (params.taskName || "") + " " + (params.task || "");
                let agentType = inferAgentTypeFromConfig(combined);
                if (!agentType && (params.taskName || "").includes("coder"))
                    agentType = "coder";
                if (!agentType && (params.taskName || "").includes("review"))
                    agentType = "reviewer";
                if (agentType && state.subAgentStates[agentType]) {
                    state.subAgentStates[agentType].spawnedAt = Date.now();
                    appendAuditLog(state, { type: "spawn", agent: agentType, tool: "sessions_spawn", target: params.agentId || "", result: "ok" });
                    console.log(`[harness-hooks] subAgentStates: ${agentType} spawn detected`);
                }
            }
            // ── Auto-Spawn V2: handoff.md detection ──
            if (event.toolName === "write") {
                const path = event.params?.path || "";
                if (path.includes("handoff.md")) {
                    if (!state.subAgentStates?.coder) {
                        state.subAgentStates = JSON.parse(JSON.stringify(getDefaultSubAgentStates()));
                    }
                    state.subAgentStates.coder.handoffDone = true;
                    state.subAgentStates.coder.handoffAt = Date.now();
                    appendAuditLog(state, { type: "handoff", agent: "coder", tool: "write", target: path, result: "ok" });
                    console.log(`[harness-hooks] subAgentStates: coder handoff detected (${path})`);
                }
            }
            // Syntax check gate: auto-validate after critical file modifications
            if (event.toolName === "write" || event.toolName === "edit") {
                const p = event.params?.path || "";
                const crit = p.includes("plugins/") || p.includes("rules/") || p.includes("index.js");
                if (crit && (p.endsWith(".js") || p.endsWith(".mjs"))) {
                    // Non-blocking: this is a diagnostic-only check (logs on failure, no
                    // gating), so avoid stalling after_tool_call up to 5s per write/edit.
                    execFile("node", ["--check", p], { timeout: 5000 }, (e) => {
                        if (e)
                            console.log("[syntax-check FAIL] " + p);
                    });
                }
                if (crit && (p.endsWith(".json"))) {
                    try {
                        JSON.parse(readFileSync(p, "utf-8"));
                    }
                    catch (e) {
                        console.log("[config-error] " + p);
                    }
                }
            }
            if (state.state === "INACTIVE") {
                saveState(state);
                return;
            }
            const output = event.result?.stdout || event.result?.text || "";
            const hasPass = /blind review PASS|✅ Done/i.test(output);
            const hasReject = /blind review REJECT/i.test(output);
            const isReviewSpawn = (event.result?.spawnedAgent || "").includes("code-reviewer");
            if ((hasPass || isReviewSpawn) && state.state !== "SPEC_REVIEW" && state.state !== "QUALITY_REVIEW") {
                // Blind review: keep current state (no transition needed,
                // SPEC_REVIEW/QUALITY_REVIEW handle the two-stage flow)
                if (state.currentCT && !state.completedCTs.includes(state.currentCT)) {
                    state.completedCTs.push(state.currentCT);
                    console.log(`[harness-hooks] CT completed: ${state.currentCT}`);
                }
                const allDone = state.ctSequence.every((ct) => state.completedCTs.includes(ct));
                if (allDone) {
                    const cc = state.completedContracts || [];
                    if (state.activeContract && !cc.includes(state.activeContract)) {
                        cc.push(state.activeContract);
                    }
                    state.completedContracts = cc;
                    transitionState(state, "LC_DONE", "all CTs completed");
                    state.currentCT = null;
                    if (!state.activeContract) {
                        transitionState(state, "INACTIVE", "LC_DONE auto-normalize (no active contract)");
                    }
                    saveState(state);
                    return;
                }
                const nextIdx = state.ctSequence.indexOf(state.currentCT) + 1;
                if (nextIdx < state.ctSequence.length) {
                    const prevCT = state.currentCT;
                    state.currentCT = state.ctSequence[nextIdx];
                    state.retryCount = 0;
                    transitionState(state, "CT_RUNNING", `${prevCT} done → ${state.currentCT}`);
                }
            }
            if (hasReject) {
                state.retryCount = (state.retryCount || 0) + 1;
                if (state.retryCount >= 3) {
                    transitionState(state, "STOPPED", `CT ${state.currentCT} rejected ${state.retryCount}x`);
                }
                else {
                    transitionState(state, "CT_RUNNING", `rejected (${state.retryCount}/3), retry`);
                }
            }
            // ── Model failure detection (skip if already suspended) ──
            if (isContractRuntimeActive(state) && state.state !== "SUSPECTED_STUCK") {
                const failure = detectModelFailure(event);
                if (failure) {
                    console.log(`[harness-hooks] model failure detected: ${failure.slice(0, 60)}`);
                    escalateModelTier(state, failure);
                    saveState(state);
                }
                else {
                    state.successfulCalls = (state.successfulCalls || 0) + 1;
                    state.consecutiveEmptyResponses = 0;
                    state.lastActivityAt = Date.now(); // update activity on success
                    if (state.successfulCalls >= 3 && state.modelTier > 0) {
                        resetModelTier(state);
                        state.successfulCalls = 0;
                    }
                    saveState(state);
                }
            }
            // Stuck detection (all active states)
            if (state.lastActivityAt && ["CT_RUNNING", "LC_ACTIVE", "SPEC_REVIEW", "QUALITY_REVIEW"].includes(state.state)) {
                const elapsed = Date.now() - state.lastActivityAt;
                if (elapsed > 30 * 60 * 1000) {
                    transitionState(state, "SUSPECTED_STUCK", "30min inactivity");
                    saveState(state);
                }
            }
            // ── Trajectory Regulation: Degeneration Detection ──
            if (isContractRuntimeActive(state) && ["CT_RUNNING", "SPEC_REVIEW", "QUALITY_REVIEW", "SUSPECTED_STUCK", "ARBITER_BLOCKED"].includes(state.state)) {
                // Track recent tool calls for degeneration detection
                if (!state.recentToolCalls)
                    state.recentToolCalls = [];
                state.recentToolCalls.push({ tool: event.toolName, ts: Date.now() });
                // Keep last 20 calls
                if (state.recentToolCalls.length > 20)
                    state.recentToolCalls.shift();
                const recent = state.recentToolCalls;
                // Pattern 1: single non-trivial tool called 8+ times in last 10 calls
                const last10 = recent.slice(-10);
                const toolCounts = {};
                last10.forEach(c => { if (!["exec", "read"].includes(c.tool))
                    toolCounts[c.tool] = (toolCounts[c.tool] || 0) + 1; });
                const maxRepeat = Math.max(...Object.values(toolCounts));
                if (maxRepeat >= 8) {
                    // Identify the tool that actually hit the max count (previously used >=5,
                    // which could name a different tool than the one with maxRepeat calls).
                    const repeatedTool = Object.keys(toolCounts).find(t => toolCounts[t] === maxRepeat);
                    console.warn(`[harness-hooks] TRAJECTORY_DEGENERATION: ${repeatedTool} called ${maxRepeat}x in last 10 calls`);
                    appendAuditLog(state, { type: "degeneration", tool: repeatedTool, count: maxRepeat, result: "warn" });
                }
                // Pattern 2: Read → Read → Read (excessive file scanning without action)
                const last6 = recent.slice(-6).map(c => c.tool);
                if (last6.length === 6 && last6.every(t => t === "read")) {
                    console.warn(`[harness-hooks] TRAJECTORY_DEGENERATION: 6 consecutive reads without action`);
                    appendAuditLog(state, { type: "degeneration", tool: "read", pattern: "6x-consecutive", result: "warn" });
                }
            }
            saveState(state);
        }, { priority: 50 });
        // ─── Universal: Subagent Failure Degradation Rule ───
        api.on("before_prompt_build", async (event, ctx) => {
            return {
                appendSystemContext: [
                    "",
                    "[HARNESS-BEHAVIOR] Subagent 失败降级策略（规则来源：memory/decisions/harness-subagent-failure-degradation.md）：",
                    "  - builder/reviewer 首次失败 → 重试（默认模型）",
                    "  - 2 次失败 → 切换 fallback 模型重试",
                    "  - 3 次失败 → 自行执行，但必须保持完整流程：self-review + auto blind review + 状态推进",
                    "  - ❗ 盲审是自动触发的，不需要等老板指令。代码写完 → 立即盲审。",
                    "  - ❗ 合约冻结后自动推进。老板说'执行'是唯一需要确认的步骤。",
                    "  - ❗ '我自己干'不是跳过流程的理由。自行执行必须自审+自盲审+自推进。",
                    "",
                    "[HARNESS-BEHAVIOR] 故障仲裁路由：",
                    "  - 流水线失败后，故障仲裁器自动分类根因（Bug/SpecGap/Ambiguity/Noise）",
                    "  - SpecGap/Ambiguity → 暂停流水线，汇报给老板等待恢复",
                    "  - Bug/Noise → 自动重试（当前行为）",
                    "  - 仲裁器 crash → 自动退化为重试行为（安全网）",
                    "  - 暂停后老板说'继续'可恢复流水线",
                    "",
                ].join("\n"),
            };
        }, { priority: 100 });
    },
});
