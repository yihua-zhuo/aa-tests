import type {
  DocumentBlock,
  DocumentClass,
  DocumentClassification,
  DocumentFieldKind,
  DocumentSchemaField,
} from '../shared/types.ts';
import { idCardValid } from './ocr-field-validation.ts';
import { parseBusinessNumber, parseDateLike } from './ocr-tables.ts';

export const DOCUMENT_CLASS_LABELS: Record<DocumentClass, string> = {
  invoice: '发票',
  receipt: '收据',
  contract: '合同',
  id_document: '证件',
  bank_receipt: '银行回单',
  purchase_order: '采购订单',
  delivery_note: '送货单',
  statement: '对账单',
  generic: '通用文档',
};

type ClassRule = {
  type: Exclude<DocumentClass, 'generic'>;
  terms: { pattern: RegExp; weight: number; label: string }[];
};

/** Weighted lexical evidence; layout and table cues are added on top. */
const RULES: readonly ClassRule[] = [
  {
    type: 'invoice',
    terms: [
      { pattern: /增值税|专用发票|普通发票/, weight: 3, label: '发票字样' },
      { pattern: /价税合计|税额|税率/, weight: 3, label: '价税字段' },
      { pattern: /发票代码|发票号码/, weight: 3, label: '发票编号标签' },
      { pattern: /\b(?:tax\s+invoice|vat\s+invoice)\b/i, weight: 3, label: 'tax invoice' },
      { pattern: /销(?:售|货)方|购买方/, weight: 1, label: '购销双方' },
    ],
  },
  {
    type: 'receipt',
    terms: [
      { pattern: /小票|收据|收银|找零/, weight: 3, label: '收据字样' },
      { pattern: /\b(?:receipt|cashier|change\s+due|subtotal)\b/i, weight: 2, label: 'receipt' },
      { pattern: /实收|实付|应付合计/, weight: 2, label: '实收字段' },
      { pattern: /微信支付|支付宝|银行卡|visa|mastercard/i, weight: 1, label: '支付方式' },
    ],
  },
  {
    type: 'contract',
    terms: [
      { pattern: /合同|协议书|补充协议/, weight: 3, label: '合同字样' },
      { pattern: /甲方|乙方|丙方/, weight: 3, label: '合同主体' },
      { pattern: /第[一二三四五六七八九十\d]+条|条款|违约金/, weight: 2, label: '合同条款' },
      { pattern: /\b(?:contract|agreement|party\s+[ab])\b/i, weight: 2, label: 'contract' },
      { pattern: /签字|盖章|签订日期/, weight: 1, label: '签署字段' },
    ],
  },
  {
    type: 'id_document',
    terms: [
      { pattern: /居民身份证|身份证|护照|驾驶证|港澳通行证/, weight: 3, label: '证件字样' },
      { pattern: /签发机关|有效期限|出生日期/, weight: 2, label: '证件字段' },
      { pattern: /\b(?:passport|identity\s+card|id\s+card)\b/i, weight: 3, label: 'id card' },
      { pattern: /\b[A-Z0-9<]{30,44}\b/, weight: 2, label: 'MRZ 码' },
    ],
  },
  {
    type: 'bank_receipt',
    terms: [
      { pattern: /银行回单|电子回单|转账凭证|汇款凭证/, weight: 3, label: '回单字样' },
      { pattern: /付款人|收款人|开户行/, weight: 3, label: '收付款人' },
      { pattern: /交易流水|回单编号|转账金额/, weight: 2, label: '回单字段' },
      { pattern: /\b(?:bank\s+receipt|remittance)\b/i, weight: 3, label: 'bank receipt' },
    ],
  },
  {
    type: 'purchase_order',
    terms: [
      { pattern: /采购订单|采购单|订购单/, weight: 3, label: '采购单字样' },
      { pattern: /供应商|供方|采购方/, weight: 2, label: '采购双方' },
      { pattern: /\b(?:purchase\s+order|p\.?o\.?\s*(?:no|number))\b/i, weight: 3, label: 'PO' },
      { pattern: /交货日期|预计到货/, weight: 1, label: '交期字段' },
    ],
  },
  {
    type: 'delivery_note',
    terms: [
      { pattern: /送货单|出库单|发货单|配送单/, weight: 3, label: '送货单字样' },
      { pattern: /收货人|收货单位|签收人/, weight: 2, label: '收货字段' },
      {
        pattern: /\b(?:delivery\s+note|packing\s+slip|consignee)\b/i,
        weight: 3,
        label: 'delivery',
      },
    ],
  },
  {
    type: 'statement',
    terms: [
      { pattern: /对账单|账单|结算单/, weight: 3, label: '对账单字样' },
      { pattern: /本期应还|最低还款|账单周期/, weight: 3, label: '账单字段' },
      {
        pattern: /\b(?:statement|billing\s+period|minimum\s+payment)\b/i,
        weight: 3,
        label: 'statement',
      },
      { pattern: /余额|balance/i, weight: 1, label: '余额字段' },
    ],
  },
];

type FieldRule = {
  key: string;
  label: string;
  kind: DocumentFieldKind;
  required: boolean;
  labels: RegExp;
  /** Fallback when the label itself is missing but a typed value exists. */
  any?: RegExp;
  validate?: (value: string) => boolean;
};

const AMOUNT = /[-+]?\d[\d,\s]*(?:\.\d{1,2})?/;
const DATE = /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/;
const IDENTIFIER = /[A-Za-z0-9][A-Za-z0-9-]{4,30}/;
const ACCOUNT = /[A-Za-z0-9][A-Za-z0-9 -]{7,40}/;

const SCHEMAS: Record<DocumentClass, FieldRule[]> = {
  invoice: [
    {
      key: 'invoiceNumber',
      label: '发票号码',
      kind: 'identifier',
      required: true,
      labels: /(?:发票号码|发票号|invoice\s*(?:no|number))\s*[:：#]?\s*/i,
      any: IDENTIFIER,
      validate: (value) => /^[A-Za-z0-9]{6,20}$/.test(value.replace(/\s+/g, '')),
    },
    {
      key: 'issueDate',
      label: '开票日期',
      kind: 'date',
      required: true,
      labels: /(?:开票日期|发票日期|invoice\s+date)\s*[:：]?\s*/i,
      any: DATE,
      validate: parseDateLike,
    },
    {
      key: 'total',
      label: '价税合计',
      kind: 'amount',
      required: true,
      labels: /(?:价税合计|合计金额|合计|总计金额|grand\s+total|total\s+amount)\s*[:：]?\s*/i,
      validate: (value) => parseBusinessNumber(value) !== null,
    },
    {
      key: 'tax',
      label: '税额',
      kind: 'amount',
      required: false,
      labels: /(?:税额|tax\s+amount)\s*[:：]?\s*/i,
      validate: (value) => parseBusinessNumber(value) !== null,
    },
    {
      key: 'seller',
      label: '销售方',
      kind: 'text',
      required: false,
      labels: /(?:销售方|销方|seller)\s*[:：]?\s*/i,
    },
  ],
  receipt: [
    {
      key: 'merchant',
      label: '商户',
      kind: 'text',
      required: true,
      labels: /(?:商户|商家|merchant)\s*[:：]?\s*/i,
      any: /[^\n]{2,40}/,
      validate: (value) => value.trim().length >= 2,
    },
    {
      key: 'date',
      label: '日期',
      kind: 'date',
      required: true,
      labels: /(?:日期|交易时间|date)\s*[:：]?\s*/i,
      any: DATE,
      validate: parseDateLike,
    },
    {
      key: 'total',
      label: '合计',
      kind: 'amount',
      required: true,
      labels: /(?:合计|总计|实收|实付|total|amount\s+due)\s*[:：]?\s*/i,
      validate: (value) => parseBusinessNumber(value) !== null,
    },
  ],
  contract: [
    {
      key: 'partyA',
      label: '甲方',
      kind: 'text',
      required: true,
      labels: /(?:甲方|委托方|发包方|party\s+a)\s*[:：]?\s*/i,
      validate: (value) => value.trim().length >= 2,
    },
    {
      key: 'partyB',
      label: '乙方',
      kind: 'text',
      required: true,
      labels: /(?:乙方|受托方|承包方|party\s+b)\s*[:：]?\s*/i,
      validate: (value) => value.trim().length >= 2,
    },
    {
      key: 'signingDate',
      label: '签订日期',
      kind: 'date',
      required: true,
      labels: /(?:签订日期|签署日期|生效日期|signing\s+date)\s*[:：]?\s*/i,
      any: DATE,
      validate: parseDateLike,
    },
    {
      key: 'contractNumber',
      label: '合同编号',
      kind: 'identifier',
      required: false,
      labels: /(?:合同编号|合同号|contract\s*(?:no|number))\s*[:：]?\s*/i,
      validate: (value) => /^[A-Za-z0-9-]{4,40}$/.test(value.replace(/\s+/g, '')),
    },
  ],
  id_document: [
    {
      key: 'name',
      label: '姓名',
      kind: 'text',
      required: true,
      labels: /(?:姓名|name)\s*[:：]?\s*/i,
      validate: (value) => value.trim().length >= 2,
    },
    {
      key: 'documentNumber',
      label: '证件号码',
      kind: 'identifier',
      required: true,
      labels:
        /(?:公民身份号码|身份证号码|身份证号|证件号码|护照号码|passport\s*(?:no|number)|document\s+no)\s*[:：]?\s*/i,
      any: /[A-Z0-9<]{8,20}/,
      validate: (value) => {
        const compact = value.replace(/\s+/g, '').toUpperCase();
        if (/^\d{17}[\dX]$/.test(compact)) return idCardValid(compact);
        return /^[A-Z0-9<]{8,20}$/.test(compact);
      },
    },
  ],
  bank_receipt: [
    {
      key: 'payer',
      label: '付款人',
      kind: 'text',
      required: true,
      labels: /(?:付款人|付款方|payer)\s*[:：]?\s*/i,
      validate: (value) => value.trim().length >= 2,
    },
    {
      key: 'payee',
      label: '收款人',
      kind: 'text',
      required: true,
      labels: /(?:收款人|收款方|payee)\s*[:：]?\s*/i,
      validate: (value) => value.trim().length >= 2,
    },
    {
      key: 'amount',
      label: '金额',
      kind: 'amount',
      required: true,
      labels: /(?:转账金额|交易金额|金额|amount)\s*[:：]?\s*/i,
      validate: (value) => parseBusinessNumber(value) !== null,
    },
    {
      key: 'date',
      label: '日期',
      kind: 'date',
      required: true,
      labels: /(?:交易日期|回单日期|日期|date)\s*[:：]?\s*/i,
      any: DATE,
      validate: parseDateLike,
    },
    {
      key: 'account',
      label: '账号',
      kind: 'account',
      required: false,
      labels: /(?:账号|账户|card\s+number|account)\s*[:：]?\s*/i,
      any: ACCOUNT,
    },
  ],
  purchase_order: [
    {
      key: 'orderNumber',
      label: '订单号',
      kind: 'identifier',
      required: true,
      labels: /(?:采购单号|订单号|p\.?o\.?\s*(?:no|number)|order\s*(?:no|number))\s*[:：]?\s*/i,
      any: IDENTIFIER,
      validate: (value) => /^[A-Za-z0-9-]{4,40}$/.test(value.replace(/\s+/g, '')),
    },
    {
      key: 'supplier',
      label: '供应商',
      kind: 'text',
      required: true,
      labels: /(?:供应商|供方|supplier|vendor)\s*[:：]?\s*/i,
      validate: (value) => value.trim().length >= 2,
    },
    {
      key: 'total',
      label: '总金额',
      kind: 'amount',
      required: true,
      labels: /(?:合计|总金额|订单金额|total)\s*[:：]?\s*/i,
      validate: (value) => parseBusinessNumber(value) !== null,
    },
  ],
  delivery_note: [
    {
      key: 'recipient',
      label: '收货人',
      kind: 'text',
      required: true,
      labels: /(?:收货人|收货单位|签收人|consignee)\s*[:：]?\s*/i,
      validate: (value) => value.trim().length >= 2,
    },
    {
      key: 'orderNumber',
      label: '订单号',
      kind: 'identifier',
      required: false,
      labels: /(?:订单号|送货单号|order\s*(?:no|number))\s*[:：]?\s*/i,
      validate: (value) => /^[A-Za-z0-9-]{4,40}$/.test(value.replace(/\s+/g, '')),
    },
    {
      key: 'date',
      label: '日期',
      kind: 'date',
      required: false,
      labels: /(?:送货日期|发货日期|日期|date)\s*[:：]?\s*/i,
      any: DATE,
      validate: parseDateLike,
    },
  ],
  statement: [
    {
      key: 'account',
      label: '账号',
      kind: 'account',
      required: true,
      labels: /(?:账号|卡号|账户|account)\s*[:：]?\s*/i,
      any: ACCOUNT,
      validate: (value) => value.replace(/[\s-]/g, '').length >= 8,
    },
    {
      key: 'statementDate',
      label: '账单日期',
      kind: 'date',
      required: true,
      labels: /(?:账单日期|对账日期|账单周期|statement\s+date)\s*[:：]?\s*/i,
      any: DATE,
      validate: parseDateLike,
    },
    {
      key: 'balance',
      label: '余额',
      kind: 'amount',
      required: true,
      labels: /(?:余额|本期应还|最低还款|balance)\s*[:：]?\s*/i,
      validate: (value) => parseBusinessNumber(value) !== null,
    },
  ],
  generic: [],
};

function compact(text: string): string {
  return text.replace(/\u3000/g, ' ').replace(/[ \t]+/g, ' ');
}

/** The value after a label stops at the next field label, pipe or line end. */
function valueAfterLabel(text: string, label: RegExp): string | null {
  const lines = compact(text).split(/\n+/);
  for (const line of lines) {
    label.lastIndex = 0;
    const match = label.exec(line);
    if (!match) continue;
    const rest = line.slice(match.index + match[0].length);
    const value = rest
      .split(/\s{3,}|[|；;]|(?:发票号码|开票日期|价税合计|税额|合计|日期)\s*[:：]/)[0]
      ?.trim();
    if (value) return value.slice(0, 200);
  }
  return null;
}

function fieldValue(text: string, rule: FieldRule): string | null {
  const labelled = valueAfterLabel(text, rule.labels);
  if (labelled) {
    const typed = rule.kind === 'amount' ? (AMOUNT.exec(labelled)?.[0] ?? labelled) : labelled;
    return typed.trim() || null;
  }
  if (!rule.any) return null;
  const match = rule.any.exec(text);
  return match ? match[0].trim() : null;
}

function schemaFor(type: DocumentClass, text: string): DocumentClassification['schema'] {
  const fields: DocumentSchemaField[] = [];
  for (const rule of SCHEMAS[type]) {
    const value = fieldValue(text, rule);
    const found = value !== null && value.trim() !== '';
    const valid = found && (rule.validate ? rule.validate(value) : true);
    fields.push({
      key: rule.key,
      label: rule.label,
      kind: rule.kind,
      required: rule.required,
      found,
      value: found ? value : null,
      valid,
    });
  }
  const required = fields.filter((field) => field.required);
  const missing = required.filter((field) => !field.found).map((field) => field.label);
  const invalid = required
    .filter((field) => field.found && !field.valid)
    .map((field) => field.label);
  const coverage =
    required.length > 0
      ? (required.filter((field) => field.found && field.valid).length / required.length) * 1
      : null;
  return {
    fields,
    missing,
    invalid,
    conflicts: [],
    coverage: coverage === null ? null : Math.round(coverage * 1000) / 1000,
  };
}

function crossConstraints(type: DocumentClass, schema: DocumentClassification['schema']): string[] {
  const byKey = new Map(schema.fields.map((field) => [field.key, field]));
  const conflicts: string[] = [];
  const amountOf = (key: string): number | null => {
    const field = byKey.get(key);
    return field?.value ? parseBusinessNumber(field.value) : null;
  };
  if (type === 'invoice') {
    const total = amountOf('total');
    const tax = amountOf('tax');
    if (total !== null && tax !== null && total + 1e-6 < tax) {
      conflicts.push(`价税合计 ${total} 小于税额 ${tax}`);
    }
  }
  if (type === 'contract') {
    const partyA = byKey.get('partyA');
    const partyB = byKey.get('partyB');
    if (partyA?.value && partyB?.value && partyA.value.trim() === partyB.value.trim()) {
      conflicts.push('甲方与乙方名称相同');
    }
  }
  if (type === 'statement') {
    const balance = amountOf('balance');
    if (balance !== null && Math.abs(balance) > 1e12) {
      conflicts.push('余额超出合理范围');
    }
  }
  return conflicts;
}

/**
 * Lightweight layout + text classifier. This is deliberately rule-based: it
 * replaces filename inference and names the schema fields that must exist,
 * without pretending to be a trained classifier. `generic` means no type
 * reached the evidence bar; its schema is empty, so scoring is unchanged.
 */
export function classifyDocument(input: {
  text: string;
  blocks?: readonly DocumentBlock[];
}): DocumentClassification {
  const text = compact(input.text);
  const lower = text.toLowerCase();
  const evidence: string[] = [];
  let best: { type: Exclude<DocumentClass, 'generic'>; score: number } | null = null;
  let second = 0;
  for (const rule of RULES) {
    let score = 0;
    for (const term of rule.terms) {
      term.pattern.lastIndex = 0;
      if (!term.pattern.test(text) && !term.pattern.test(lower)) continue;
      score += term.weight;
      evidence.push(`${rule.type}:${term.label}`);
    }
    if (score > (best?.score ?? 0)) {
      second = best?.score ?? 0;
      best = { type: rule.type, score };
    } else if (score > second) {
      second = score;
    }
  }
  const tables = input.blocks?.filter((block) => block.type === 'table').length ?? 0;
  if (tables > 0 && best) {
    // A table is weak support for transaction documents, never for contracts.
    if (best.type !== 'contract' && best.type !== 'id_document') {
      best = { ...best, score: best.score + 0.5 };
      evidence.push(`${best.type}:${tables} 个表格`);
    }
  }
  const top = best?.score ?? 0;
  if (!best || top < 2 || top - second < 1) {
    return {
      type: 'generic',
      confidence: top > 0 ? 0.5 : 0,
      evidence,
      schema: schemaFor('generic', text),
    };
  }
  const confidence = Math.min(1, 0.5 + (top - second) / (2 * top));
  const schema = schemaFor(best.type, text);
  schema.conflicts = crossConstraints(best.type, schema);
  return {
    type: best.type,
    confidence: Math.round(confidence * 1000) / 1000,
    evidence,
    schema,
  };
}
