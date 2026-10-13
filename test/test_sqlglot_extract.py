"""Unit tests of scripts/sqlglot_extract.py — the join edges the parse recovers (correlated subqueries,
inline views / CTEs, IN-subquery and EXISTS semi-joins) on excerpts of REAL corpus statements
(work.clear_sql, trimmed to the clauses under test), plus the plain-join regressions.

Run (build/test only in the CloudBeaver distro, the parser pin is asserted at import):
  docker run --rm -v <repo>:/app -w /app python:3.12-slim sh -c \
    "pip install -q sqlglot==30.18.0 && python -m unittest -v test/test_sqlglot_extract.py"
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import sqlglot_extract as sx  # noqa: E402

#: the column dictionary qualify() binds unqualified columns with (the pipeline uses work.meta_columns)
DICT = {
    "ENQ_ISSUES_VL": ["ISSUE_ID", "ORGANIZATION_ID", "SOURCE", "QUALITY_TYPE_ID"],
    "ENQ_ACTIONS_VL": ["ACTION_ID", "ORGANIZATION_ID", "ACTION_TYPE"],
    "INV_ORGANIZATION_DEFINITIONS_V": ["ORGANIZATION_ID", "ORGANIZATION_CODE", "ORGANIZATION_NAME"],
    "ENQ_QUALITY_TYPES_VL": ["QUALITY_TYPE_ID", "LABEL"],
    "FND_LOOKUPS": ["LOOKUP_CODE", "LOOKUP_TYPE", "MEANING", "DESCRIPTION"],
    "MKT_SC_SOURCE_CODES": ["SOURCE_CODE_ID", "CAMPAIGN_ID", "ACTIVITY_NAME"],
    "MKT_CM_CAMPAIGNS": ["CAMPAIGN_ID", "CAMPAIGN_NAME", "ORGANIZATION_ID", "TEMPLATE_FLAG"],
    "JTF_RS_GROUP_MEMBERS": ["GROUP_ID", "RESOURCE_ID", "DELETE_FLAG"],
    "FND_TREE_NODE_RF": ["PK1_VALUE", "TREE_CODE", "TREE_VERSION_ID"],
    "VCS_PARTICIPANTS": ["VCS_PARTICIPANT_ID", "PARTNER_CODE", "ORGANIZATION_ID", "VENDOR_ID", "VENDOR_SITE_ID"],
    "VCS_COLLAB_IDENTITY": ["SHIP_FROM_ID", "SHIP_TO_ID"],
    "INV_ORG_PARAMETERS": ["ORGANIZATION_ID", "ORGANIZATION_CODE"],
    "AP_INVOICES_ALL": ["INVOICE_ID", "VENDOR_ID", "ORG_ID"],
    "POZ_SUPPLIERS": ["VENDOR_ID", "SEGMENT1"],
    "AP_PAYMENT_SCHEDULES_ALL": ["INVOICE_ID", "AMOUNT_REMAINING"],
    "HZ_PARTIES": ["PARTY_ID", "PARTY_NAME"],
}
sx.COLUMNS_RESOLVER = lambda tables: {t: {c: "TEXT" for c in DICT[t]} for t in tables if t in DICT}


def joins(sql):
    r = sx.extract_one(("t", "bip-report", sql))
    assert r["quality"] in ("full", "full_lex"), r
    return set(r["joins"])


def pair(a, b):
    """the undirected edge a=b, whatever side the parse put first"""
    return {a, b}


def edges(js):
    return [({f"{ft}.{fc}", f"{tt}.{tc}"}, jt) for ft, fc, tt, tc, jt in js]


class RecoveredJoins(unittest.TestCase):
    def test_correlated_scalar_subquery_enq_issues(self):
        # work.clear_sql e0dd8892… (BIP quality-issue report): the org code/name are correlated scalar
        # subqueries on the outer alias ISSUEEO
        sql = """SELECT ISSUEEO.ISSUE_ID,
       ISSUEEO.ORGANIZATION_ID,
       (SELECT MEANING FROM FUSION.FND_LOOKUPS WHERE LOOKUP_CODE =  ISSUEEO.SOURCE AND LOOKUP_TYPE='ORA_ENQ_SOURCE') AS SOURCE_NAME,
       (SELECT QUALITYTYPE.LABEL FROM FUSION.ENQ_QUALITY_TYPES_VL QUALITYTYPE WHERE QUALITYTYPE.QUALITY_TYPE_ID = ISSUEEO.QUALITY_TYPE_ID) AS QUALITY_TYPE_LABEL,
       (SELECT ORG.ORGANIZATION_CODE FROM FUSION.INV_ORGANIZATION_DEFINITIONS_V ORG WHERE ORG.ORGANIZATION_ID =ISSUEEO.ORGANIZATION_ID) AS ORGANIZATION_CODE,
	   (SELECT ORG.ORGANIZATION_NAME FROM FUSION.INV_ORGANIZATION_DEFINITIONS_V ORG WHERE ORG.ORGANIZATION_ID =ISSUEEO.ORGANIZATION_ID) AS ORGANIZATION_NAME
FROM  FUSION.ENQ_ISSUES_VL ISSUEEO
WHERE ISSUEEO.ISSUE_ID=:bindIssueId"""
        e = edges(joins(sql))
        self.assertIn((pair("ENQ_ISSUES_VL.ORGANIZATION_ID", "INV_ORGANIZATION_DEFINITIONS_V.ORGANIZATION_ID"), "WHERE"), e)
        self.assertIn((pair("ENQ_ISSUES_VL.QUALITY_TYPE_ID", "ENQ_QUALITY_TYPES_VL.QUALITY_TYPE_ID"), "WHERE"), e)
        self.assertIn((pair("ENQ_ISSUES_VL.SOURCE", "FND_LOOKUPS.LOOKUP_CODE"), "WHERE"), e)

    def test_correlated_scalar_subquery_enq_actions(self):
        # work.clear_sql 5c77baaa… (BIP quality-action report)
        sql = """SELECT ACTIONEO.ACTION_ID,
       ACTIONEO.ORGANIZATION_ID,
       (SELECT ORG.ORGANIZATION_CODE FROM FUSION.INV_ORGANIZATION_DEFINITIONS_V ORG WHERE ORG.ORGANIZATION_ID =ACTIONEO.ORGANIZATION_ID) AS ORGANIZATION_CODE
FROM  FUSION.ENQ_ACTIONS_VL ACTIONEO
WHERE  ACTIONEO.ACTION_ID=:bindActionId"""
        self.assertIn(pair("ENQ_ACTIONS_VL.ORGANIZATION_ID", "INV_ORGANIZATION_DEFINITIONS_V.ORGANIZATION_ID"), [p for p, _ in edges(joins(sql))])

    def test_in_subquery_semi_join_with_union_mkt(self):
        # work.clear_sql c192f8c7… (OTBI Marketing Campaign): the campaign's ORGANIZATION_ID is a resource
        # group — `IN ((SELECT gm1.group_id …) UNION ALL (SELECT to_number(…) …))`; only the column branch pairs
        sql = """SELECT SourceCodePEO.SOURCE_CODE_ID, CampaignPEO.CAMPAIGN_NAME
FROM MKT_SC_SOURCE_CODES SourceCodePEO, MKT_CM_CAMPAIGNS CampaignPEO
WHERE (SourceCodePEO.CAMPAIGN_ID = CampaignPEO.CAMPAIGN_ID) AND ( ( 1 = 1 ) OR (CampaignPEO.campaign_id in (
  (select cm3.campaign_id from mkt_cm_campaigns cm3 where cm3.organization_id in ((select gm1.group_id group_id from jtf_rs_group_members gm1 where gm1.delete_flag = 'N' and gm1.resource_id = (select HZ_SESSION_UTIL.GET_USER_PARTYID from dual)) union all (select to_number(tn.pk1_value) group_id from fnd_tree_node_rf tn where tn.tree_code = 'X'))))))
AND ( (CampaignPEO.TEMPLATE_FLAG = 'N' ) )"""
        e = edges(joins(sql))
        self.assertIn((pair("MKT_CM_CAMPAIGNS.ORGANIZATION_ID", "JTF_RS_GROUP_MEMBERS.GROUP_ID"), "SEMI"), e)
        self.assertIn((pair("MKT_SC_SOURCE_CODES.CAMPAIGN_ID", "MKT_CM_CAMPAIGNS.CAMPAIGN_ID"), "WHERE"), e)
        self.assertFalse(any("FND_TREE_NODE_RF.PK1_VALUE" in p for p, _ in e), "a function branch pairs nothing")

    def test_inline_view_join_vcs(self):
        # work.clear_sql 01e6e091… (OTBI supplier collaboration): two inline views joined on their
        # ORGANIZATION_ID outputs; the correlated EXISTS inside the first is a semi-join
        sql = """SELECT V200628678.PARTNER_CODE, V504241628.ORGANIZATION_CODE1
FROM (SELECT SCCollaborationParticipantsP.VCS_PARTICIPANT_ID, SCCollaborationParticipantsP.PARTNER_CODE, SCCollaborationParticipantsP.ORGANIZATION_ID, SCCollaborationParticipantsP.VENDOR_ID
      FROM VCS_PARTICIPANTS SCCollaborationParticipantsP
      WHERE (SCCollaborationParticipantsP.PARTNER_CODE IN ('SUPPLIER','ENTERPRISE')) AND ( EXISTS ( select 1 from VCS_COLLAB_IDENTITY iden
            WHERE (iden.SHIP_FROM_ID = SCCollaborationParticipantsP.VCS_PARTICIPANT_ID or iden.SHIP_TO_ID = SCCollaborationParticipantsP.VCS_PARTICIPANT_ID ) ) )) V200628678,
     (SELECT OrganizationParameterPEO.ORGANIZATION_ID, OrgOrganizationDefinitionsP.ORGANIZATION_CODE AS ORGANIZATION_CODE1, OrgOrganizationDefinitionsP.ORGANIZATION_ID AS ORGANIZATION_ID1
      FROM INV_ORG_PARAMETERS OrganizationParameterPEO, INV_ORGANIZATION_DEFINITIONS_V OrgOrganizationDefinitionsP
      WHERE OrganizationParameterPEO.ORGANIZATION_ID = OrgOrganizationDefinitionsP.ORGANIZATION_ID) V504241628
WHERE (V200628678.ORGANIZATION_ID = V504241628.ORGANIZATION_ID(+)) AND ( ( (V200628678.PARTNER_CODE = 'ENTERPRISE' ) ) )"""
        e = edges(joins(sql))
        self.assertIn((pair("VCS_PARTICIPANTS.ORGANIZATION_ID", "INV_ORG_PARAMETERS.ORGANIZATION_ID"), "WHERE"), e)
        self.assertIn((pair("VCS_COLLAB_IDENTITY.SHIP_FROM_ID", "VCS_PARTICIPANTS.VCS_PARTICIPANT_ID"), "SEMI"), e)
        self.assertIn((pair("VCS_COLLAB_IDENTITY.SHIP_TO_ID", "VCS_PARTICIPANTS.VCS_PARTICIPANT_ID"), "SEMI"), e)
        self.assertIn((pair("INV_ORG_PARAMETERS.ORGANIZATION_ID", "INV_ORGANIZATION_DEFINITIONS_V.ORGANIZATION_ID"), "WHERE"), e)

    def test_cte_column_alias_followed(self):
        sql = """WITH s AS (SELECT p.organization_id AS oid FROM vcs_participants p)
SELECT 1 FROM s, inv_org_parameters q WHERE s.oid = q.organization_id"""
        self.assertIn((pair("VCS_PARTICIPANTS.ORGANIZATION_ID", "INV_ORG_PARAMETERS.ORGANIZATION_ID"), "WHERE"), edges(joins(sql)))

    def test_plain_in_subquery_semi_join(self):
        sql = "SELECT a.invoice_id FROM ap_invoices_all a WHERE a.vendor_id IN (SELECT s.vendor_id FROM poz_suppliers s WHERE s.segment1 LIKE 'A%')"
        self.assertEqual(edges(joins(sql)), [(pair("AP_INVOICES_ALL.VENDOR_ID", "POZ_SUPPLIERS.VENDOR_ID"), "SEMI")])


class Regressions(unittest.TestCase):
    def test_ansi_and_comma_joins_unchanged(self):
        sql = """SELECT a.invoice_id FROM ap_invoices_all a JOIN poz_suppliers s ON s.vendor_id = a.vendor_id,
                 ap_payment_schedules_all ps WHERE ps.invoice_id = a.invoice_id AND a.org_id = 204"""
        self.assertEqual(sorted(edges(joins(sql)), key=str), sorted([
            (pair("AP_INVOICES_ALL.VENDOR_ID", "POZ_SUPPLIERS.VENDOR_ID"), "INNER"),
            (pair("AP_INVOICES_ALL.INVOICE_ID", "AP_PAYMENT_SCHEDULES_ALL.INVOICE_ID"), "WHERE"),
        ], key=str))

    def test_nested_equality_attributed_by_its_own_scope_only(self):
        # the inner alias `a` shadows the outer `a`: the inner equality belongs to the inner scope
        sql = """SELECT a.invoice_id FROM ap_invoices_all a
                 WHERE EXISTS (SELECT 1 FROM hz_parties a, poz_suppliers s WHERE a.party_id = s.vendor_id)"""
        e = edges(joins(sql))
        self.assertIn((pair("HZ_PARTIES.PARTY_ID", "POZ_SUPPLIERS.VENDOR_ID"), "WHERE"), e)
        self.assertFalse(any("AP_INVOICES_ALL.PARTY_ID" in p for p, _ in e), "never resolved through the outer alias")

    def test_predicates_through_inline_view(self):
        r = sx.extract_one(("t", "bip-report", "SELECT v.x FROM (SELECT p.partner_code AS x FROM vcs_participants p) v WHERE v.x = 'SUPPLIER'"))
        self.assertIn(("VCS_PARTICIPANTS", "PARTNER_CODE", "EQ", "'SUPPLIER'", "where"), r["predicates"])


if __name__ == "__main__":
    unittest.main()
