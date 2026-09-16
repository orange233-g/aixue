import {
  validateStructure,
  validateAnswer,
  validateCount,
  validateDuplicate,
  validateSafety,
  validateQuestion,
} from '../src/services/validation'
import type { Question } from '../src/types'

let pass = 0
let fail = 0
function assert(cond: boolean, name: string) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}`)
  }
}

function q(partial: Partial<Question>): Question {
  return {
    id: 'q1',
    type: 'single',
    stem: '题干',
    options: ['A', 'B'],
    answer: '[0]',
    explanation: '解析',
    kp_ids: ['kp1'],
    difficulty: 1,
    ...partial,
  }
}

// ---- AC-3.1 结构校验：题干 / 答案 / 解析缺失 ----
console.log('AC-3.1 结构校验')
assert(validateStructure(q({})).length === 0, '完整题目无缺失')
assert(validateStructure(q({ stem: '' })).some((m) => m.includes('题干')), '题干缺失被标记')
assert(validateStructure(q({ stem: '   ' })).some((m) => m.includes('题干')), '题干纯空格被标记')
assert(validateStructure(q({ answer: '' })).some((m) => m.includes('答案')), '答案缺失被标记')
assert(validateStructure(q({ explanation: '' })).some((m) => m.includes('解析')), '解析缺失被标记')
assert(validateStructure(q({ type: 'single', options: ['A'] })).some((m) => m.includes('选项')), '选择题选项不足被标记')
assert(validateStructure(q({ type: 'single', options: [] })).some((m) => m.includes('选项')), '选择题无选项被标记')
assert(validateStructure(q({ type: 'fill' })).length === 0, '填空题无需选项')
assert(validateStructure(q({ type: 'judge', options: ['正确', '错误'] })).length === 0, '判断题有选项通过')

// ---- AC-3.2 答案合法性 ----
console.log('AC-3.2 答案合法性')
assert(validateAnswer(q({ type: 'single', answer: '[0]' })).length === 0, '单选答案在范围内通过')
assert(validateAnswer(q({ type: 'single', answer: '[5]' })).some((m) => m.includes('范围')), '单选答案越界被标记')
assert(validateAnswer(q({ type: 'single', answer: '[-1]' })).some((m) => m.includes('范围')), '单选答案负数被标记')
assert(validateAnswer(q({ type: 'single', answer: 'abc' })).some((m) => m.includes('范围')), '单选答案非数组被标记')
assert(validateAnswer(q({ type: 'multiple', answer: '[0,1]' })).length === 0, '多选答案在范围内通过')
assert(validateAnswer(q({ type: 'multiple', answer: '[0,9]' })).some((m) => m.includes('范围')), '多选答案越界被标记')
assert(validateAnswer(q({ type: 'judge', answer: 'true' })).length === 0, '判断题 true 通过')
assert(validateAnswer(q({ type: 'judge', answer: 'false' })).length === 0, '判断题 false 通过')
assert(validateAnswer(q({ type: 'judge', answer: 'yes' })).some((m) => m.includes('true/false')), '判断题非 true/false 被标记')
assert(validateAnswer(q({ type: 'judge', answer: '' })).some((m) => m.includes('true/false')), '判断题空答案被标记')
assert(validateAnswer(q({ type: 'fill', answer: '北京' })).length === 0, '填空答案非空通过')
assert(validateAnswer(q({ type: 'fill', answer: '' })).length === 0, '填空答案空由结构校验标记（此处不重复）')

// ---- AC-3.3 题型数量核对 ----
console.log('AC-3.3 题型数量核对')
assert(validateCount({ single: 2 }, [q({ type: 'single' }), q({ type: 'single' })]).length === 0, '数量一致通过')
assert(validateCount({ single: 2 }, [q({ type: 'single' })]).some((m) => m.includes('期望 2')), '数量不足提示差异')
assert(validateCount({ single: 1 }, [q({ type: 'single' }), q({ type: 'single' })]).some((m) => m.includes('期望 1')), '数量超出提示差异')
assert(validateCount({ single: 0 }, [q({ type: 'single' })]).length === 0, '期望 0 的题型不核对')
assert(validateCount({ single: 2, judge: 1 }, [q({ type: 'single' }), q({ type: 'single' }), q({ type: 'judge' })]).length === 0, '多题型数量一致通过')

// ---- AC-3.4 去重 ----
console.log('AC-3.4 去重')
assert(validateDuplicate([q({}), q({ id: 'q2', stem: '另一道题' })]).length === 0, '不同题干不重复')
assert(validateDuplicate([q({}), q({ id: 'q2', stem: '题干' })]).some((m) => m.includes('重复')), '相同题干判重复')
assert(validateDuplicate([q({}), q({ id: 'q2', stem: ' 题干 ' })]).some((m) => m.includes('重复')), '空白差异忽略判重复')
assert(validateDuplicate([q({}), q({ id: 'q2', stem: '题干' }), q({ id: 'q3', stem: '题干' })]).filter((m) => m.includes('重复')).length === 2, '三道同题干标记 2 条重复')

// ---- AC-3.5 内容安全 ----
console.log('AC-3.5 内容安全')
assert(validateSafety(q({})).length === 0, '正常内容通过')
assert(validateSafety(q({ stem: '正常内容' })).length === 0, '正常中文通过')
assert(validateSafety(q({ stem: 'a\u0000b' })).some((m) => m.includes('异常')), '控制字符被拦截')
assert(validateSafety(q({ stem: 'a\u001Fb' })).some((m) => m.includes('异常')), '单元分隔符被拦截')
assert(validateSafety(q({ explanation: 'x\u000B' })).some((m) => m.includes('异常')), '解析含控制字符被拦截')

// ---- 综合校验入口 ----
console.log('综合校验入口')
assert(validateQuestion(q({})).length === 0, '完整题目综合校验通过')
assert(validateQuestion(q({ stem: '', answer: '' })).length >= 2, '多缺失合并标记')
assert(validateQuestion(q({ type: 'judge', answer: 'yes' })).some((m) => m.includes('true/false')), '综合校验含答案合法性')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
