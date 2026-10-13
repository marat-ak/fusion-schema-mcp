| table | type | usage | class | evidence |
|---|---|---|---|---|
| HCM_LOOKUPS | VIEW | 1750 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| PER_LOCATION_DETAILS_F_TL | TABLE | 256 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_CONTENT_TYPES_VL | VIEW | 191 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_RATING_LEVELS_VL | VIEW | 169 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HR_LOOKUPS | VIEW | 160 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_CONTENT_ITEMS_TL | TABLE | 151 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_CONTENT_ITEMS_VL | VIEW | 140 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_CONTENT_ITEMS_B | TABLE | 132 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_PROFILE_TYP_SECTIONS_VL | VIEW | 132 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| WLF_LEARNING_ITEMS_F_TL | TABLE | 106 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRQ_QSTNR_PARTICIPANTS | TABLE | 93 | VIA_PARENT | PARTICIPANT_ID -> HRA_EVAL_PARTICIPANTS.EVAL_PARTICIPANT_ID via corpus_join [leaky; chain leaky; hops 1] |
| HRT_CONTENT_TYPES_TL | TABLE | 92 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_RATING_LEVELS_B | TABLE | 92 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_RATING_LEVELS_TL | TABLE | 87 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRC_TXN_DATA | TABLE | 78 | VIA_PARENT | TRANSACTION_ID -> HRC_TXN_HEADER.TRANSACTION_ID via corpus_join [strict; chain strict; hops 1] |
| HRQ_QSTNR_RESPONSES | TABLE | 77 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_PROFILES_TL | TABLE | 74 | VIA_PARENT | PROFILE_ID -> HRT_PROFILES_B.PROFILE_ID via corpus_join [strict; chain strict; hops 1] |
| HRQ_QUESTIONNAIRES_B | TABLE | 73 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_PROFILE_RELATIONS | TABLE | 72 | VIA_PARENT | PROFILE_ID -> HRT_PROFILES_B.PROFILE_ID via corpus_join [strict; chain strict; hops 1] |
| PER_ACTION_REASONS_TL | TABLE | 72 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRQ_QSTNR_QUESTIONS | TABLE | 69 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| PER_ASSIGNMENT_STATUS_TYPES_TL | TABLE | 69 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| PER_ACTION_REASONS_B | TABLE | 66 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| WLF_AR_RELATIONS_F | TABLE | 62 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_RATING_MODELS_B | TABLE | 61 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_RATING_MODELS_TL | TABLE | 59 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRQ_QSTN_RESPONSES | TABLE | 58 | UNSECURABLE | no context column, no FK and no dominant corpus join to a secured object |
| HRQ_QUESTIONS_B | TABLE | 58 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| PAY_ELEMENT_TYPES_TL | TABLE | 58 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
| HRT_PROFILE_TYP_SECTIONS | TABLE | 57 | UNSECURABLE | reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent |
