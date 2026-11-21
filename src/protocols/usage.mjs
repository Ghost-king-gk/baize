// @ts-check
/**
 * 四协议共用的 usage 归一化。
 *
 * 规则：字段缺失、类型不是 number、或不是有限数 → null。
 * 不要用 Number() 强转字符串：'0' 会变成 0，把「未知」伪装成「免费」。
 */

/**
 * @typedef {{
 *   inputTokens: number | null,
 *   outputTokens: number | null,
 *   reasoningTokens: number | null,
 *   cachedTokens: number | null,
 *   cost: number | null,
 *   listCost: number | null,
 *   billingSource: string | null
 * }} Usage
 */

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function numberOrNull(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function stringOrNull(value) {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 费用字段在四种协议里位置一致：usage（Gemini 为 usageMetadata）下的
 * cost 与 opencode.{billing_source,list_cost}。
 * @param {any} usage
 * @returns {{cost: number | null, listCost: number | null, billingSource: string | null}}
 */
export function costFields(usage) {
	return {
		cost: numberOrNull(usage?.cost),
		listCost: numberOrNull(usage?.opencode?.list_cost),
		billingSource: stringOrNull(usage?.opencode?.billing_source)
	};
}
