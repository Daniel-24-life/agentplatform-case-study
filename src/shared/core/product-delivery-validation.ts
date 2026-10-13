import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../../../schemas/product-delivery.schema.json' with { type: 'json' };
import { ProductDeliveryError, type ProductDelivery, type ProductDeliveriesApi, type ProductDeliveryState } from '../contracts/product-delivery.js';
export type ProductDeliveryMethod = keyof ProductDeliveriesApi;
const ajv = new Ajv2020({ strict: true, ownProperties: true }); ajv.addSchema(schema);
const methods: ProductDeliveryMethod[] = ['getState','create'];
const inputs = new Map(methods.map(method => [method,ajv.compile({$ref:schema.$id+'#/$defs/'+method})]));
const outputs = new Map(methods.map(method => [method,ajv.compile({$ref:schema.$id+'#/$defs/'+method+'Response'})]));
export function assertProductDeliveryInput(method: ProductDeliveryMethod, value: unknown): void {
 if (new TextEncoder().encode(JSON.stringify(value)).length > 128 * 1024) throw new ProductDeliveryError('INPUT_TOO_LARGE','交付记录过大。');
 if (!inputs.get(method)!(value)) throw new ProductDeliveryError('INVALID_INPUT','产品交付请求不正确。');
}
export function assertProductDeliveryResponse(method: ProductDeliveryMethod, value: unknown, productId: string): void {
 if (new TextEncoder().encode(JSON.stringify(value)).length > 256 * 1024 || !outputs.get(method)!(value)) throw new ProductDeliveryError('INVALID_RESPONSE','产品交付响应不正确。');
 const result = value as {ok:boolean;value:ProductDelivery|ProductDeliveryState}; if(!result.ok)return;
 if(result.value.productId!==productId)throw new ProductDeliveryError('INVALID_RESPONSE','产品身份不匹配。');
 const delivery = method==='getState' ? (result.value as ProductDeliveryState).latest : result.value as ProductDelivery;
 if(!delivery) {
  if(method==='getState' && (result.value as ProductDeliveryState).current)throw new ProductDeliveryError('INVALID_RESPONSE','没有交付记录时不能标为当前交付。');
  return;
 }
 const ids=delivery.criteria.map(c=>c.id), reviews=delivery.reviews;
 if(new Set(ids).size!==ids.length || reviews.length!==ids.length || new Set(reviews.map(r=>r.criterionId)).size!==ids.length || reviews.some(r=>!ids.includes(r.criterionId)||!r.note.trim()||(r.accepted&&r.taskCriterionIds.length===0)))throw new ProductDeliveryError('INVALID_RESPONSE','产品验收清单不完整。');
 const accepted=delivery.criteria.every(c=>!c.required||reviews.find(r=>r.criterionId===c.id)?.accepted);
 if(accepted!==(delivery.status==='ACCEPTED_UNPUBLISHED'))throw new ProductDeliveryError('INVALID_RESPONSE','产品验收状态不一致。');
}
