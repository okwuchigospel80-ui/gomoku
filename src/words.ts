// Word bank for 你画我猜.
//
// Pure data, no imports, no side effects — the picker lives in `drawguess.ts` so
// this file can be read (and edited) as a plain list.
//
// Three levels:
//   easy 日常物品 — concrete nouns that anyone can sketch in a few strokes
//   mid  动作 / 职业 — needs a subject doing something
//   hard 抽象 / 成语 — the fun ones: no single right picture
//
// Every word is at most 4 characters, so the length hint on the guesser's screen
// stays useful.

export type Level = 'easy' | 'mid' | 'hard'

export interface Word {
  text: string
  level: Level
}

export const LEVEL_LABEL: Record<Level, string> = {
  easy: '简单',
  mid: '中等',
  hard: '困难',
}

const EASY = [
  '太阳', '月亮', '星星', '云朵', '彩虹', '雨伞', '眼镜', '手表',
  '帽子', '围巾', '手套', '鞋子', '书包', '铅笔', '橡皮', '尺子',
  '书本', '台灯', '水杯', '筷子', '勺子', '碗', '锅', '冰箱',
  '电视', '手机', '电脑', '键盘', '鼠标', '耳机', '相机', '钥匙',
  '门', '窗户', '床', '椅子', '桌子', '沙发', '镜子', '牙刷',
  '毛巾', '梳子', '剪刀', '锤子', '气球', '风筝', '皮球', '自行车',
  '汽车', '飞机', '火车', '轮船', '房子', '桥', '树', '花',
  '苹果', '香蕉', '西瓜', '蛋糕',
]

const MID = [
  '跑步', '游泳', '跳远', '投篮', '踢球', '滑雪', '爬山', '钓鱼',
  '做饭', '洗碗', '扫地', '洗衣', '睡觉', '打哈欠', '大笑', '哭',
  '生气', '思考', '拍照', '唱歌', '跳舞', '弹琴', '打鼓', '画画',
  '写字', '读书', '打电话', '打字', '开车', '骑车', '医生', '老师',
  '警察', '消防员', '厨师', '理发师', '司机', '农民', '画家', '歌手',
  '演员', '律师', '程序员', '快递员', '服务员', '宇航员', '潜水员', '魔术师',
  '小丑', '园丁', '牙医', '护士', '保安', '摄影师', '飞行员', '面包师',
  '木匠', '排队', '握手', '鼓掌',
]

const HARD = [
  '自由', '孤独', '幸福', '时间', '爱情', '梦想', '回忆', '秘密',
  '勇气', '希望', '后悔', '嫉妒', '焦虑', '平静', '坚持', '选择',
  '命运', '成长', '告别', '等待', '陪伴', '信任', '谎言', '原谅',
  '思念', '重生', '破釜沉舟', '画蛇添足', '守株待兔', '掩耳盗铃', '亡羊补牢', '刻舟求剑',
  '井底之蛙', '对牛弹琴', '火上浇油', '雪中送炭', '一箭双雕', '三心二意', '半途而废', '一鸣惊人',
  '水滴石穿', '望梅止渴', '叶公好龙', '狐假虎威', '塞翁失马', '朝三暮四', '杯弓蛇影', '囫囵吞枣',
  '拔苗助长', '南辕北辙', '面红耳赤', '手忙脚乱', '目瞪口呆', '画龙点睛', '锦上添花', '破镜重圆',
  '隔岸观火', '顺手牵羊', '骑虎难下', '心花怒放',
]

export const WORDS: readonly Word[] = [
  ...EASY.map((text): Word => ({ text, level: 'easy' })),
  ...MID.map((text): Word => ({ text, level: 'mid' })),
  ...HARD.map((text): Word => ({ text, level: 'hard' })),
]

/** Level pools, precomputed once so a pick is a single array index. */
export const WORDS_BY_LEVEL: Record<Level, readonly Word[]> = {
  easy: WORDS.filter((w) => w.level === 'easy'),
  mid: WORDS.filter((w) => w.level === 'mid'),
  hard: WORDS.filter((w) => w.level === 'hard'),
}

/** Number of characters, counting code points rather than UTF-16 units. */
export const charLength = (text: string): number => [...text].length
