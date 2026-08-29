-- SYNTHETIC SEED DATA. Everything below is invented for a portfolio demo.
--
-- "VERIDANE" is a FICTIONAL product that does not exist. The references point at
-- FICTIONAL studies. No real drug, no real claim, no real trial, no real patient
-- data appears anywhere in this repository. Do not reuse this content for
-- anything other than exercising the demo.

DELETE FROM artifact_segments;
DELETE FROM audit_events;
DELETE FROM artifacts;
DELETE FROM claims;
DELETE FROM reference_docs;
DELETE FROM prompt_versions;

-- ---- References (fictional) ------------------------------------------------
INSERT INTO reference_docs (id, citation, anchor) VALUES
 ('REF-001','Fictional Study VDN-301, data on file (2025)','Table 2, p.14 (primary endpoint)'),
 ('REF-002','Fictional Study VDN-301, data on file (2025)','Section 5.2, p.31 (adverse events)'),
 ('REF-003','VERIDANE fictional Prescribing Information (2025)','Section 1, Indications and Usage'),
 ('REF-004','VERIDANE fictional Prescribing Information (2025)','Boxed Warning, p.1'),
 ('REF-005','Fictional Study VDN-402, data on file (2026)','Table 1, p.9 (open-label extension)');

-- ---- Claims (fictional, all pre-approved) ----------------------------------
INSERT INTO claims (id, product, audience, claim_text, reference_id, claim_type) VALUES
 ('CLM-001','VERIDANE','hcp',
  'In a 24-week trial, VERIDANE reduced the primary endpoint score by 4.2 points versus 1.8 with placebo.',
  'REF-001','efficacy'),
 ('CLM-002','VERIDANE','hcp',
  'VERIDANE is indicated for moderate to severe disease in adults who have had an inadequate response to first-line therapy.',
  'REF-003','indication'),
 ('CLM-003','VERIDANE','hcp',
  'The most common adverse reactions were headache (12%), nausea (9%) and fatigue (7%).',
  'REF-002','safety'),
 ('CLM-004','VERIDANE','hcp',
  'WARNING: RISK OF SERIOUS INFECTION. Discontinue VERIDANE if a serious infection develops. See full Prescribing Information.',
  'REF-004','safety'),
 ('CLM-005','VERIDANE','hcp',
  'Response was maintained through 52 weeks in the open-label extension.',
  'REF-005','efficacy'),
 ('CLM-006','VERIDANE','patient',
  'VERIDANE is a prescription medicine for adults whose current treatment has not worked well enough.',
  'REF-003','indication'),
 ('CLM-007','VERIDANE','patient',
  'The most common side effects are headache, nausea and tiredness.',
  'REF-002','safety'),
 ('CLM-008','VERIDANE','patient',
  'WARNING: RISK OF SERIOUS INFECTION. Tell your doctor right away if you have signs of an infection.',
  'REF-004','safety');

-- A RETIRED claim. It must never be offered to the model, which is the point of
-- having status on the claim rather than filtering in the prompt.
INSERT INTO claims (id, product, audience, claim_text, reference_id, claim_type, status) VALUES
 ('CLM-009','VERIDANE','hcp',
  'VERIDANE is more effective than competitor therapy.',
  'REF-001','comparative','retired');

-- ---- Prompt versions -------------------------------------------------------
-- Versions are rows, not edits. v1 is kept to show that the record of an older
-- generation still resolves after the prompt has moved on.
INSERT INTO prompt_versions (id, name, version, body, body_sha256, notes) VALUES
 ('assemble@1','assemble',1,
  'Write promotional copy for the product using the supplied claims.',
  'seed-v1-not-recomputed',
  'v1: too loose. The model paraphrased claims and dropped the safety block.'),
 ('assemble@2','assemble',2,
  'You arrange pre-approved claims into promotional copy.

RULES
1. You may ONLY output claims from the CLAIMS list, copied VERBATIM. Never paraphrase, merge, split or reword a claim.
2. Output every claim whose type is "safety". These are required.
3. Do not add transitions, headlines, calls to action, or any sentence of your own.
4. You are choosing ORDER and SELECTION only. You are not an author.
5. Return JSON: {"segments":[{"claim_id":"CLM-XXX"}]} and nothing else.

A sentence you invent cannot be substantiated, so it cannot be approved. Selecting and ordering approved claims is the whole task.',
  'seed-v2-not-recomputed',
  'v2: verbatim-only + mandatory safety claims. Current.');
