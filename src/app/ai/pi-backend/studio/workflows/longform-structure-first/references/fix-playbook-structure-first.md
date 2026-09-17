# Fix Playbook（polish 段诊断表）

阶段 4 polish 段逐项排查修复。

| 症状          | 检测                                   | 动作                                                                        | 升级条件                                   |
| ------------- | -------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| 文字溢出/截断 | describe error                         | set_text 精简 / set_text_resize / node_resize；仍挤则字号降一档（不破下限） | 同节 2 轮仍 error → 砍内容密度，结论区声明 |
| 对比度不足    | describe warning                       | set_fill / set_text_properties 拉开明度差                                   | 与风格冲突 → look 复验后结论区声明         |
| 占位符残留    | describe + look                        | 补图或 set_fill 补语义色                                                    | 缺素材 → 问用户或记「待补」                |
| 跨节颜色漂移  | look 逐节对照                          | set_fill 统一到方向色域                                                     | 2 轮仍不一致 → 回 CP2                      |
| 接缝可见      | look 根框/hero 区                      | 重新调用 compose_backdrop                                                   | 重调 2 次仍可见 → 重生 hero                |
| 字阶越轨      | describe 树字号对照 profile Typography | set_text_properties 调档                                                    | —                                          |
| 图内嵌文字    | look 候选/落图节点                     | 重生成，prompt 写「不出现任何文字」                                         | 2 次仍带字 → 换素材路线                    |
