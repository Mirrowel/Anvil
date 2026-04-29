/**
 * @anvil/agent-core/skills — public skills barrel.
 *
 * Phase 1: parser + loader + activator. Phase 2 will add render +
 * resolveSkillsDir + integration with the system prompt build path.
 */

export type { Skill, SkillFrontmatter, SkillLoadOptions } from './types.js';
export { parseSkillMarkdown, type ParsedSkill } from './parser.js';
export { loadSkills } from './loader.js';
export { activateSkills, type ActivatedSkills } from './activator.js';
