<!-- ================================================================= -->
<!--  EVAL CANON — MUST NEVER BE INGESTED.                             -->
<!--  This file is NOT part of the retrieval corpus. It is the         -->
<!--  ground-truth fact sheet used to score copilot answers.           -->
<!--  It lives in data/_eval/ (underscore prefix) specifically so any   -->
<!--  ingestion glob scoped to data/internal/ cannot reach it. Any      -->
<!--  future ingester MUST skip every directory whose name begins with  -->
<!--  an underscore. Do NOT move this file into data/internal/.         -->
<!-- ================================================================= -->

# CANON — Sahyadri Freight Carriers Pvt. Ltd. (internal eval fact sheet)

**Operator.** Sahyadri Freight Carriers Private Limited (trading as "Sahyadri
Roadlines"). Mid-size road freight operator, inter-state goods carriage on the
western corridor (MMR–Gujarat–NCR lane cluster).
**Registered office.** Gut No. 217/3, Village Kalher, Bhiwandi–Kalyan Road,
Bhiwandi, Dist. Thane, Maharashtra 421302.
**Fleet size.** 140 owned goods vehicles (as of eval baseline).
**CIN (fictional).** U60231MH2009PTC194207.

## 1. Vehicle classes

| Class | Description | GVW band (kg) | Typical use | Reg. series (base MH-04) | Licence needed |
|-------|-------------|---------------|-------------|--------------------------|----------------|
| A | Light goods carrier (pickup / LCV) | up to 3,490 | Intra-MMR feeder, parcel, last-mile | MH-04 GA / MH-04 GB | LMV-Transport |
| B | Medium goods vehicle (rigid 2-axle) | 3,491 – 12,010 | Regional distribution, short-haul | MH-04 KC | HMV / HGMV |
| C | Heavy goods vehicle (rigid multi-axle) | 12,011 – 25,480 | Inter-state trunk haul | MH-04 KH | HMV / HGMV |
| D | Articulated tractor + semi-trailer | 25,481 – 43,120 | Long-haul bulk / container | MH-04 TT | HMV + multi-axle endorsement |

## 2. Insurance mapping (EXPLICIT — do not restate policy contents)

| Class | Package policy | Insurer | Owner-driver PA (Sec IV) |
|-------|----------------|---------|--------------------------|
| A | Goods Carrying Vehicle Package Policy | Raheja QBE Genl. Insurance | Rs. 15 lakh |
| B | Goods Carrying Vehicle Package Policy | Raheja QBE Genl. Insurance | Rs. 15 lakh |
| C | Commercial Vehicle Package Policy | Magma HDI Genl. Insurance | Rs. 2 lakh |
| D | Commercial Vehicle Package Policy | Magma HDI Genl. Insurance | Rs. 2 lakh |

- Class C and D (heavy/articulated) carry **Endorsement IMT-23** (full cover, no
  depreciation, on lamps/tyres/tubes/mudguards/bonnet/bumper/paint) on the Magma HDI
  Commercial Vehicle Package Policy. Classes A and B do not.
- Removal/towing indemnity for "other commercial vehicles" is capped at **Rs. 2,500**
  per accident under Section I(3) of *both* package policies (source: policy wordings).
- Constructive Total Loss = aggregate repair/retrieval cost **exceeds 75% of IDV**
  (source: policy wordings).
- **Rationale for the split (history, not preference):** the A/B fleet was originally
  insured under the Raheja QBE Goods Carrying Vehicle Package Policy; the C/D fleet
  arrived through the acquisition of an earlier operator whose vehicles were already on
  the Magma HDI Commercial Vehicle Package Policy, and those cover lines (including
  Endorsement IMT-23) were carried over at renewal. The mapping is therefore a legacy of
  the acquisition, documented in ABR (see §2 note and ABR-4.x).

## 3. Driver grades

| Grade | Eligibility | Classes drivable | Route eligibility | Day allowance | Night-out (halt) | Trunk incentive |
|-------|-------------|------------------|-------------------|---------------|------------------|-----------------|
| DG-1 (Feeder Driver) | LMV-Transport, ≥ 2 yrs exp | A only | **R1 only** | Rs. 342 | not applicable | — |
| DG-2 (Staff Driver) | HMV, ≥ 4 yrs exp | A, B, C | R1, R2, R3 | Rs. 476 | Rs. 638 | — |
| DG-3 (Senior Trunk Driver) | HMV + multi-axle endt., ≥ 7 yrs | A, B, C, D | R1, R2, R3 | Rs. 615 | Rs. 840 | Rs. 1,120 / completed trunk trip |

- **DG-1 route restriction (resolves halt-eligibility determinism).** DG-1 drivers are
  rostered on **R1 (local/feeder) duties only** and are **not assignable to R2 or R3**.
  Because R1 carries no overnight halt, DG-1 has no night-out rate by construction —
  there is no "DG-1 on an R2 route" case to answer. Any exception requires a written
  waiver from the depot manager under DAP-5.4 and, where it would breach rest, remains
  bounded by DAP-3.2.

## 4. Route classes

| Route class | One-way distance | Overnight halt rule |
|-------------|------------------|---------------------|
| R1 (Local / feeder) | up to 185 km | Not halt-eligible; day return expected |
| R2 (Regional) | 186 – 640 km | One halt permitted only if statutory rest cannot be completed at base |
| R3 (Trunk / inter-state) | above 640 km | Multi-night halts; halt allowance per night |

## 5. Depots

| Code | Name | Location |
|------|------|----------|
| BWD | Bhiwandi Central Hub (HQ) | Kalher, Bhiwandi, Thane |
| PNU | Panvel Cross-dock | Panvel, Raigad |
| NSK | Nashik Satellite Depot | Sinnar MIDC, Nashik |
| VPI | Vapi Border Depot | Vapi, Valsad, Gujarat |

## 6. Cross-reference scheme

- **DAP-x.x** — Driver Allowance & Overnight Halt Policy
- **FCR-x.x** — Fuel Card & Reimbursement SOP
- **ABR-x.x** — Accident & Breakdown Reporting Procedure
- **PMS-x.x** — Preventive Maintenance Schedule

## 7. Numeric fact ledger (each fact owned by exactly one SOP)

| # | Fact | Value | Owning doc | Clause |
|---|------|-------|-----------|--------|
| 1 † | Internal minimum inter-duty rest (above the statutory 9-hr floor) | 11 hours | DAP | DAP-3.2 |
| 2 | Max continuous driving before mandatory break | 4 hours 20 min driving / 40-min break | DAP | DAP-3.4 |
| 3 | DG-1 daily road allowance | Rs. 342 | DAP | DAP-4.1 |
| 4 | DG-2 daily road allowance | Rs. 476 | DAP | DAP-4.1 |
| 5 | DG-3 night-out (halt) allowance | Rs. 840 | DAP | DAP-4.3 |
| 6 | Trunk-trip completion incentive (DG-3, R3) | Rs. 1,120 | DAP | DAP-4.4 |
| 7 | Minimum one-way distance to qualify for overnight halt | 186 km | DAP | DAP-5.1 |
| 8 | Fuel norm — Class A / B / C / D | 8.60 / 5.40 / 3.85 / 3.05 km per litre | FCR | FCR-4.2 |
| 9 | Fuel-norm variance tolerance before review | 7.5% | FCR | FCR-4.4 |
| 10 | Fuel-card single-txn ceiling w/o pre-auth | Rs. 14,750 | FCR | FCR-3.3 |
| 11 | Monthly fuel-card limit — Class A / B / C / D | Rs. 41,900 / 88,400 / 1,63,200 / 2,14,600 | FCR | FCR-3.2 |
| 12 | Reimbursement claim deadline after trip close | 9 calendar days | FCR | FCR-6.1 |
| 13 | Telephonic accident report to Control Room | within 35 minutes | ABR | ABR-3.1 |
| 14 | Written incident report (Form ABR/IR-1) | within 22 hours | ABR | ABR-3.3 |
| 15 | Insurer intimation deadline | within 51 hours | ABR | ABR-4.2 |
| 16 | Depot breakdown recovery float (excess over policy cap) | Rs. 6,300 | ABR | ABR-5.3 |
| 17 | Spill / HAZMAT cordon radius | 55 m | ABR | ABR-6.2 |
| 18 | Service interval — Class A / B | 14,200 km / 12,300 km | PMS | PMS-4.1 |
| 19 | Service interval — Class C / D | 11,500 km (480 eng-hr) / 9,800 km (420 eng-hr) | PMS | PMS-4.1 |
| 20 | Pre-monsoon inspection window | 15 May – 9 June | PMS | PMS-5.1 |
| 21 | Brake-lining minimum residual thickness | 3.2 mm | PMS | PMS-6.2 |
| 22 † | Internal tyre NSD condemnation limit (above the statutory 1.6-mm floor) | 2.4 mm | PMS | PMS-6.3 |
| 23 † | Internal repair-cost survey trigger (below the policy 75%-of-IDV CTL line) | 62% of IDV | PMS | PMS-7.1 |

**† Paired-threshold facts (distinct eval category).** Facts 1, 22 and 23 each set an
*internal* figure against a *statutory or contractual* counterpart. The owning clause
MUST cite the external counterpart **by identifier, in the running text** (not merely
imply it), so the eval can test that retrieval returns both numbers together:

- Fact 1 → internal 11 hr **vs** statutory 9 hr under **MTW Act 1961, s.15(2)** (cited in DAP-3.2).
- Fact 22 → internal 2.4 mm **vs** statutory 1.6 mm under **CMVR 1989, Rule 94** (cited in PMS-6.3).
- Fact 23 → internal 62% survey trigger **vs** contractual CTL at 75% of IDV under
  **Section I (Constructive Total Loss) of the applicable package policy** (cited in PMS-7.1).

## 8. Cross-document dependencies (answer needs SOP + a public PDF)

- **CD-1 — Owner-driver PA sum for a vehicle class.** Resolve via canon §2 (class →
  policy) + ABR-4.x (names the policy per class) + **Section IV of that policy** (Rs. 2
  lakh Magma HDI / Rs. 15 lakh Raheja QBE). Neither doc alone answers "PA sum for a
  Class C vehicle."
- **CD-2 — On-spot recovery reimbursement.** ABR-5.3 pays the depot float **only for the
  excess over** the removal cap in **Section I(3) of the applicable package policy**
  (Rs. 2,500). The cap lives in the policy PDF; the float in the SOP.
- **CD-3 — Condemnation / total loss.** PMS-7.1 fires an internal survey at 62% of IDV,
  but formal condemnation follows the **CTL definition (repair > 75% of IDV)** in the
  applicable package policy. Threshold lives in the policy PDF.
- (Statutory anchor, also cross-doc) DAP-3.2's 11-hour rest sits above the 9-hour
  statutory floor in **MTW Act 1961, s.15(2)** — SOP + MTW Act PDF.

## 9. Seed-data requirements

Not for SOP prose. These are conditions the seed script must satisfy so that
cross-tool eval questions return non-empty results.

1. At least one driver whose COMPLETED trips within a single calendar week sum
   to more than 48 hours of (completedAt − dispatchedAt). Backs the MTW Act
   s.13 statutory-vs-actual question.
2. At least one driver with two consecutive trips whose inter-duty gap
   (next dispatchedAt − previous completedAt) falls between 9 and 11 hours —
   compliant with s.15(2) but breaching DAP-3.2. Plus one gap under 9 hours,
   breaching both.
3. At least one Class C vehicle where (odometer − lastServiceOdometer) exceeds
   11,500 km, i.e. overdue against PMS-4.1.
4. At least one FINE-type Expense attached to a dispatched trip, so safetyScore
   has a traceable input.
5. At least one vehicle per class A/B/C/D, with registrationNo matching the
   canon series prefixes, so the class→policy mapping is resolvable from data.
6. At least one trip whose actual distance diverges from plannedDistance by
   more than the FCR-4.4 variance tolerance.
