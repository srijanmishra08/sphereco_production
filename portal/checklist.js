/* =============================================================================
   Spherecho Partner Portal — document checklist schema
   -----------------------------------------------------------------------------
   The single source of truth for what a Seller/Producer must submit during
   film-rights due diligence. Everything the portal renders — sections, upload
   slots, the closing readiness panel — is derived from this file, so adding or
   re-wording a requirement is a data edit, not a UI edit.

   Each document carries an `expect` block. That block is the plug point for the
   per-document template checks we will define later: today it drives the generic
   verifier in verify.js (keywords, identifiers, signature/date heuristics);
   once templates arrive, `SPX.checklist.applyTemplate(docId, {...})` overlays
   stricter rules onto the same block without touching any other layer.
   ========================================================================== */
(function (global) {
    'use strict';

    var SPX = global.SPX = global.SPX || {};

    /* Accepted upload types, by shorthand used below. */
    var ACCEPT = {
        doc: ['pdf', 'docx', 'doc', 'jpg', 'png'],
        pdfOnly: ['pdf'],
        scan: ['pdf', 'jpg', 'png'],
        sheet: ['pdf', 'docx', 'xlsx', 'csv']
    };

    /* Identifier patterns we can extract and validate from Indian corporate docs. */
    var ID = {
        pan: 'pan',
        gstin: 'gstin',
        cin: 'cin',
        llpin: 'llpin',
        cbfc: 'cbfc'
    };

    /* -------------------------------------------------------------------------
       Sections 1 – 11
       ---------------------------------------------------------------------- */
    var SECTIONS = [
        {
            id: 'seller',
            no: '1',
            title: 'Seller / Producer Documents',
            blurb: 'Corporate identity of the selling entity and proof that the person signing is authorised to sign.',
            docs: [
                {
                    id: 'seller.incorporation',
                    ref: '1(a)',
                    label: 'Certificate of Incorporation / LLP Incorporation Certificate',
                    hint: 'As applicable to the entity type. Issued by the MCA / Registrar of Companies.',
                    required: true,
                    multiple: false,
                    accept: ACCEPT.scan,
                    expect: {
                        keywordsAny: ['certificate of incorporation', 'incorporation certificate', 'registrar of companies', 'limited liability partnership'],
                        identifiers: [ID.cin, ID.llpin],
                        identifiersMode: 'any',
                        wantsDate: true,
                        wantsSignature: false,
                        matchEntityName: true
                    }
                },
                {
                    id: 'seller.pan',
                    ref: '1(b)',
                    label: 'PAN of the selling entity',
                    hint: 'Company/LLP PAN card. The PAN on the card must match the PAN entered on the entity profile.',
                    required: true,
                    multiple: false,
                    accept: ACCEPT.scan,
                    expect: {
                        keywordsAny: ['permanent account number', 'income tax department', 'pan'],
                        identifiers: [ID.pan],
                        identifiersMode: 'all',
                        crossCheck: 'profile.pan',
                        matchEntityName: true
                    }
                },
                {
                    id: 'seller.gst',
                    ref: '1(b)',
                    label: 'GST registration certificate',
                    hint: 'Form GST REG-06. The GSTIN must match the GSTIN entered on the entity profile.',
                    required: true,
                    multiple: false,
                    accept: ACCEPT.scan,
                    expect: {
                        keywordsAny: ['goods and services tax', 'registration certificate', 'gstin', 'reg-06'],
                        identifiers: [ID.gstin],
                        identifiersMode: 'all',
                        crossCheck: 'profile.gstin',
                        matchEntityName: true
                    }
                },
                {
                    id: 'seller.corporate',
                    ref: '1(b)',
                    label: 'Basic corporate details',
                    hint: 'MOA/AOA or LLP agreement, latest MCA master data, and the current list of directors/partners.',
                    required: true,
                    multiple: true,
                    accept: ACCEPT.doc,
                    expect: {
                        keywordsAny: ['memorandum of association', 'articles of association', 'llp agreement', 'director', 'designated partner'],
                        matchEntityName: true
                    }
                },
                {
                    id: 'seller.resolution',
                    ref: '1(c)',
                    label: 'Board / Partner Resolution approving the sale or assignment',
                    hint: 'Certified true copy of the resolution approving the sale/assignment of the film and its rights.',
                    required: true,
                    multiple: false,
                    accept: ACCEPT.doc,
                    expect: {
                        keywordsAll: ['resolved'],
                        keywordsAny: ['board of directors', 'resolution', 'certified true copy', 'partners'],
                        wantsDate: true,
                        wantsSignature: true,
                        matchEntityName: true,
                        matchFilmTitle: true
                    }
                },
                {
                    id: 'seller.signatory',
                    ref: '1(d)',
                    label: 'Proof of authority of the signatory',
                    hint: 'Power of attorney or authorisation letter naming the person signing on behalf of the Seller, plus their photo ID.',
                    required: true,
                    multiple: true,
                    accept: ACCEPT.doc,
                    expect: {
                        keywordsAny: ['authorised signatory', 'authorized signatory', 'power of attorney', 'authorisation', 'authorization'],
                        wantsSignature: true,
                        crossCheck: 'profile.signatoryName'
                    }
                }
            ]
        },
        {
            id: 'title',
            no: '2',
            title: 'Chain of Title / Ownership Documents',
            blurb: 'An unbroken paper trail from the original idea to the Seller’s present ownership of the film.',
            docs: [
                {
                    id: 'title.story',
                    ref: '2(a)',
                    label: 'Story / idea acquisition agreement',
                    required: true, multiple: true, accept: ACCEPT.doc,
                    expect: { keywordsAny: ['story', 'idea', 'concept', 'assignment', 'acquisition'], wantsSignature: true, wantsDate: true, matchFilmTitle: true }
                },
                {
                    id: 'title.writers',
                    ref: '2(b)',
                    label: 'Screenplay and dialogue writer agreements',
                    required: true, multiple: true, accept: ACCEPT.doc,
                    expect: { keywordsAny: ['screenplay', 'dialogue', 'writer', 'script'], wantsSignature: true, wantsDate: true, matchFilmTitle: true }
                },
                {
                    id: 'title.director',
                    ref: '2(c)',
                    label: 'Director agreement',
                    required: true, multiple: true, accept: ACCEPT.doc,
                    expect: { keywordsAny: ['director'], wantsSignature: true, wantsDate: true, matchFilmTitle: true }
                },
                {
                    id: 'title.producers',
                    ref: '2(d)',
                    label: 'Producer / co-producer agreements',
                    hint: 'If applicable.',
                    required: false, multiple: true, accept: ACCEPT.doc,
                    expect: { keywordsAny: ['producer', 'co-producer', 'co producer'], wantsSignature: true, wantsDate: true, matchFilmTitle: true }
                },
                {
                    id: 'title.underlying',
                    ref: '2(e)',
                    label: 'Agreements through which the Seller acquired the underlying rights',
                    required: true, multiple: true, accept: ACCEPT.doc,
                    expect: { keywordsAny: ['underlying rights', 'assignment', 'grant of rights', 'acquire'], wantsSignature: true, matchEntityName: true }
                },
                {
                    id: 'title.copyright',
                    ref: '2(f)',
                    label: 'Copyright assignment agreements / deeds and amendments',
                    required: true, multiple: true, accept: ACCEPT.doc,
                    expect: { keywordsAll: ['copyright'], keywordsAny: ['assignment', 'assign', 'deed'], wantsSignature: true, wantsDate: true }
                },
                {
                    id: 'title.adaptation',
                    ref: '2(g)',
                    label: 'Adaptation / remake / other underlying work agreements',
                    hint: 'If the film adapts or remakes an existing work.',
                    required: false, multiple: true, accept: ACCEPT.doc,
                    expect: { keywordsAny: ['adaptation', 'remake', 'derivative', 'based on'], wantsSignature: true }
                },
                {
                    id: 'title.nocs',
                    ref: '2(h)',
                    label: 'NOCs / consents relating to ownership or transfer',
                    required: false, multiple: true, accept: ACCEPT.doc,
                    expect: { keywordsAny: ['no objection', 'noc', 'consent'], wantsSignature: true }
                },
                {
                    id: 'title.registration',
                    ref: '2(i)',
                    label: 'Copyright registration certificates',
                    hint: 'If available.',
                    required: false, multiple: true, accept: ACCEPT.scan,
                    expect: { keywordsAny: ['copyright office', 'registration of copyrights', 'diary no', 'registration number'], wantsDate: true }
                }
            ]
        },
        {
            id: 'crew',
            no: '3',
            title: 'Cast & Crew Agreements / NOCs',
            blurb: 'Executed agreements or NOCs for every principal contributor, confirming rights are secured and no payment, royalty or credit claims are pending.',
            docs: [
                { id: 'crew.director', ref: '3(a)', label: 'Director', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['director'], wantsSignature: true, wantsDate: true, noDues: true } },
                { id: 'crew.dop', ref: '3(b)', label: 'Director of Photography', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['cinematograph', 'director of photography', 'dop'], wantsSignature: true, noDues: true } },
                { id: 'crew.writers', ref: '3(c)', label: 'Writers', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['writer', 'screenplay', 'dialogue', 'story'], wantsSignature: true, noDues: true } },
                { id: 'crew.cast', ref: '3(d)', label: 'Actors / cast', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['artist', 'actor', 'cast', 'performer'], wantsSignature: true, noDues: true } },
                { id: 'crew.composer', ref: '3(e)', label: 'Music composer(s)', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['composer', 'music'], wantsSignature: true, noDues: true } },
                { id: 'crew.lyricist', ref: '3(f)', label: 'Lyricist(s)', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['lyric', 'lyricist'], wantsSignature: true, noDues: true } },
                { id: 'crew.singers', ref: '3(g)', label: 'Singers', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['singer', 'vocalist', 'playback'], wantsSignature: true, noDues: true } },
                { id: 'crew.editor', ref: '3(h)', label: 'Editor', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['editor', 'editing'], wantsSignature: true, noDues: true } },
                { id: 'crew.designer', ref: '3(i)', label: 'Production designer', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['production designer', 'art director', 'production design'], wantsSignature: true, noDues: true } },
                { id: 'crew.vfx', ref: '3(j)', label: 'VFX and post-production teams', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['vfx', 'visual effects', 'post-production', 'post production', 'di ', 'colour grad', 'color grad'], wantsSignature: true, noDues: true } },
                { id: 'crew.other', ref: '3(k)', label: 'Other key contributors', hint: 'Any other contributor whose work forms part of the film.', required: false, multiple: true, accept: ACCEPT.doc, expect: { wantsSignature: true, noDues: true } }
            ]
        },
        {
            id: 'music',
            no: '4',
            title: 'Music & Sound Rights',
            blurb: 'Ownership or licensing of every piece of music in the film, including masters and publishing.',
            docs: [
                { id: 'music.creators', ref: '4(a)', label: 'Composer, lyricist and singer agreements', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['composer', 'lyricist', 'singer'], wantsSignature: true, noDues: true } },
                { id: 'music.producer', ref: '4(b)', label: 'Music producer agreements', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['music producer', 'programmer', 'arranger'], wantsSignature: true } },
                { id: 'music.score', ref: '4(c)', label: 'Background score agreement(s)', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['background score', 'bgm', 'score'], wantsSignature: true } },
                { id: 'music.licences', ref: '4(d)', label: 'Licences for pre-existing music used in the film', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['licence', 'license', 'synchronisation', 'synchronization', 'sync'], wantsSignature: true, wantsTerm: true } },
                { id: 'music.masters', ref: '4(e)', label: 'Ownership / licensing of master recordings and publishing rights', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['master recording', 'sound recording', 'publishing', 'mechanical'], wantsSignature: true } },
                { id: 'music.nocs', ref: '4(f)', label: 'Music-related NOCs / clearances', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['no objection', 'noc', 'clearance', 'iprs', 'ppl', 'novex'], wantsSignature: true } },
                { id: 'music.cuesheet', ref: '4(g)', label: 'Music cue sheet', hint: 'If available.', required: false, multiple: false, accept: ACCEPT.sheet, expect: { keywordsAny: ['cue sheet', 'cue', 'timecode', 'duration'] } }
            ]
        },
        {
            id: 'locations',
            no: '5',
            title: 'Location Releases / NOCs & Production Permissions',
            blurb: 'Permission to have filmed where the film was filmed.',
            docs: [
                { id: 'locations.releases', ref: '5(a)', label: 'Location release agreements / NOCs', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['location', 'release', 'no objection', 'premises'], wantsSignature: true, wantsDate: true } },
                { id: 'locations.owners', ref: '5(b)', label: 'Permissions from property owners / occupiers', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['owner', 'occupier', 'permission', 'premises'], wantsSignature: true } },
                { id: 'locations.government', ref: '5(c)', label: 'Government / authority permissions', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['permission', 'police', 'municipal', 'authority', 'collector', 'railway', 'forest'], wantsDate: true } },
                { id: 'locations.studio', ref: '5(d)', label: 'Studio / location agreements', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['studio', 'floor', 'set', 'agreement'], wantsSignature: true } },
                { id: 'locations.other', ref: '5(e)', label: 'Other specific permissions or releases', required: false, multiple: true, accept: ACCEPT.doc, expect: { wantsSignature: true } }
            ]
        },
        {
            id: 'thirdparty',
            no: '6',
            title: 'Third-Party Content & Clearances',
            blurb: 'Licences or NOCs for every piece of third-party material appearing in the film.',
            docs: [
                { id: 'thirdparty.archival', ref: '6(a)', label: 'Archival footage', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['archival', 'archive', 'footage', 'licence', 'license'], wantsTerm: true } },
                { id: 'thirdparty.stock', ref: '6(b)', label: 'Stock footage / images', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['stock', 'royalty-free', 'royalty free', 'licence', 'license'], wantsTerm: true } },
                { id: 'thirdparty.photos', ref: '6(c)', label: 'Photographs', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['photograph', 'photo', 'image', 'licence', 'license'] } },
                { id: 'thirdparty.artwork', ref: '6(d)', label: 'Artwork', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['artwork', 'painting', 'illustration', 'artist'] } },
                { id: 'thirdparty.marks', ref: '6(e)', label: 'Logos / trademarks', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['trademark', 'trade mark', 'logo', 'brand', 'no objection'] } },
                { id: 'thirdparty.press', ref: '6(f)', label: 'Newspaper / magazine / news content', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['newspaper', 'magazine', 'news', 'publication', 'licence', 'license'] } },
                { id: 'thirdparty.music', ref: '6(g)', label: 'Pre-existing music or audio', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['music', 'audio', 'sound recording', 'licence', 'license'] } },
                { id: 'thirdparty.clips', ref: '6(h)', label: 'Clips from other films / programmes', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['clip', 'excerpt', 'film', 'programme', 'licence', 'license'] } },
                { id: 'thirdparty.other', ref: '6(i)', label: 'Any other third-party material', required: false, multiple: true, accept: ACCEPT.doc, expect: {} }
            ]
        },
        {
            id: 'lifeRights',
            no: '7',
            title: 'Real Persons / Life Rights',
            blurb: 'Required only if the film is based on, or depicts, real persons or real-life events.',
            conditional: 'profile.depictsRealPersons',
            docs: [
                { id: 'life.agreements', ref: '7(a)', label: 'Life rights / consent agreements', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['life rights', 'life story', 'consent'], wantsSignature: true, wantsDate: true } },
                { id: 'life.nil', ref: '7(b)', label: 'Name, image, likeness and publicity releases', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['likeness', 'publicity', 'name and image', 'personality rights'], wantsSignature: true } },
                { id: 'life.permissions', ref: '7(c)', label: 'Relevant permissions / NOCs', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['no objection', 'noc', 'permission'], wantsSignature: true } },
                { id: 'life.correspondence', ref: '7(d)', label: 'Other agreements or correspondence on the depiction', required: false, multiple: true, accept: ACCEPT.doc, expect: {} }
            ]
        },
        {
            id: 'cbfc',
            no: '8',
            title: 'CBFC & Regulatory Documents',
            blurb: 'Certification status and any conditions attached to it.',
            docs: [
                {
                    id: 'cbfc.certificate', ref: '8(a)', label: 'Final CBFC Certificate', required: true, multiple: false, accept: ACCEPT.scan,
                    expect: { keywordsAny: ['central board of film certification', 'cbfc', 'certificate no'], identifiers: [ID.cbfc], identifiersMode: 'any', wantsDate: true, matchFilmTitle: true }
                },
                { id: 'cbfc.application', ref: '8(b)', label: 'CBFC application and correspondence / undertakings', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['application', 'undertaking', 'examining committee', 'cbfc'] } },
                { id: 'cbfc.cuts', ref: '8(c)', label: 'Details of cuts or modifications required by the CBFC', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['cut', 'modification', 'excision', 'deletion', 'nil'] } },
                { id: 'cbfc.notices', ref: '8(d)', label: 'Pending notices or proceedings relating to the film', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['notice', 'proceeding', 'nil', 'none'] } }
            ]
        },
        {
            id: 'finance',
            no: '9',
            title: 'Financing & Encumbrances',
            blurb: 'Who funded the film, and whether anything is charged, pledged or assigned against it.',
            docs: [
                { id: 'finance.production', ref: '9(a)', label: 'Production financing / investment agreements', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['financing', 'investment', 'funding', 'investor'], wantsSignature: true, wantsDate: true } },
                { id: 'finance.loans', ref: '9(b)', label: 'Loan or financing agreements', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['loan', 'facility', 'borrower', 'lender'], wantsSignature: true } },
                { id: 'finance.security', ref: '9(c)', label: 'Security, charge or hypothecation documents', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['charge', 'hypothecation', 'security interest', 'chg-1', 'mortgage'], wantsDate: true } },
                { id: 'finance.investors', ref: '9(d)', label: 'Investor agreements and revenue / profit-sharing arrangements', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['revenue share', 'profit share', 'investor', 'waterfall'], wantsSignature: true } },
                { id: 'finance.interests', ref: '9(e)', label: 'Details of any lien, pledge, charge, assignment or third-party interest', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['lien', 'pledge', 'charge', 'encumbrance', 'nil', 'none'] } },
                {
                    id: 'finance.noEncumbrance', ref: '9†', label: 'No Encumbrance Declaration',
                    hint: 'Written confirmation on the Seller’s letterhead that the film and the rights being transferred are free from encumbrance and third-party claims, save as disclosed.',
                    required: true, multiple: false, accept: ACCEPT.doc,
                    expect: {
                        keywordsAll: ['encumbrance'],
                        keywordsAny: ['free from', 'free of', 'no encumbrance', 'unencumbered'],
                        wantsSignature: true, wantsDate: true, matchEntityName: true, matchFilmTitle: true, declaration: true
                    }
                }
            ]
        },
        {
            id: 'dues',
            no: '10',
            title: 'Outstanding Dues & Liabilities',
            blurb: 'Confirmation that nobody who worked on the film is still owed money. A No Dues Declaration/Certificate is preferred.',
            docs: [
                { id: 'dues.crew', ref: '10(a)', label: 'Outstanding cast and crew dues', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['dues', 'outstanding', 'payable', 'nil', 'no dues'] } },
                { id: 'dues.vendors', ref: '10(b)', label: 'Vendor / production dues', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['vendor', 'dues', 'outstanding', 'nil'] } },
                { id: 'dues.music', ref: '10(c)', label: 'Music-related dues or royalties', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['royalt', 'music', 'dues', 'nil'] } },
                { id: 'dues.financiers', ref: '10(d)', label: 'Financier / investor dues', required: true, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['financier', 'investor', 'dues', 'repayment', 'nil'] } },
                { id: 'dues.other', ref: '10(e)', label: 'Any other outstanding liability', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['liabilit', 'outstanding', 'nil', 'none'] } },
                {
                    id: 'dues.declaration', ref: '10†', label: 'No Dues Declaration / Certificate',
                    hint: 'Preferred. Signed declaration on the Seller’s letterhead covering cast, crew, vendors, music and financiers.',
                    required: true, multiple: false, accept: ACCEPT.doc,
                    expect: {
                        keywordsAny: ['no dues', 'nil dues', 'no outstanding', 'fully paid'],
                        wantsSignature: true, wantsDate: true, matchEntityName: true, matchFilmTitle: true, declaration: true
                    }
                }
            ]
        },
        {
            id: 'litigation',
            no: '11',
            title: 'Litigation / Claims / Notices',
            blurb: 'Anything pending or threatened that touches the film, its production or its exploitation.',
            docs: [
                { id: 'litigation.pending', ref: '11(a)', label: 'Pending or threatened litigation', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['suit', 'petition', 'court', 'litigation', 'nil', 'none'] } },
                { id: 'litigation.notices', ref: '11(b)', label: 'Legal notices', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['legal notice', 'notice', 'advocate', 'nil'] } },
                { id: 'litigation.ip', ref: '11(c)', label: 'Copyright or trademark disputes', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['copyright', 'trademark', 'infringement', 'dispute', 'nil'] } },
                { id: 'litigation.personality', ref: '11(d)', label: 'Defamation, privacy or publicity-right claims', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['defamation', 'privacy', 'publicity', 'claim', 'nil'] } },
                { id: 'litigation.contract', ref: '11(e)', label: 'Contractual disputes', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['breach', 'dispute', 'arbitration', 'nil'] } },
                { id: 'litigation.payment', ref: '11(f)', label: 'Payment claims', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['claim', 'payment', 'recovery', 'nil'] } },
                { id: 'litigation.other', ref: '11(g)', label: 'Any other claim or proceeding', required: false, multiple: true, accept: ACCEPT.doc, expect: {} },
                {
                    id: 'litigation.declaration', ref: '11†', label: 'No Litigation / Claims Declaration',
                    hint: 'Signed confirmation that no claims or proceedings affecting the film or the rights are pending or threatened, other than those disclosed.',
                    required: true, multiple: false, accept: ACCEPT.doc,
                    expect: {
                        keywordsAny: ['no litigation', 'no claim', 'no proceeding', 'not pending', 'nor threatened', 'no pending'],
                        wantsSignature: true, wantsDate: true, matchEntityName: true, matchFilmTitle: true, declaration: true
                    }
                }
            ]
        },
        {
            id: 'distribution',
            no: '12',
            title: 'Existing Distribution / Licensing',
            blurb: 'Any rights already granted to a third party, which would carve into what is being sold.',
            docs: [
                { id: 'distribution.agreements', ref: '12(a)', label: 'Existing distribution / licensing agreements', hint: 'If any. Include theatrical, satellite, digital, music and overseas deals.', required: false, multiple: true, accept: ACCEPT.doc, expect: { keywordsAny: ['distribution', 'licence', 'license', 'theatrical', 'satellite', 'digital', 'ott'], wantsSignature: true, wantsTerm: true } },
                { id: 'distribution.ownership', ref: '12(b)', label: 'Seller’s confirmation of clear and lawful ownership', hint: 'Written confirmation that the Seller owns the film and the rights being transferred, free of competing grants.', required: true, multiple: false, accept: ACCEPT.doc, expect: { keywordsAny: ['sole and exclusive', 'lawful owner', 'absolute owner', 'clear title', 'owner of the film'], wantsSignature: true, wantsDate: true, matchEntityName: true, matchFilmTitle: true, declaration: true } }
            ]
        }
    ];

    /* -------------------------------------------------------------------------
       Closing checklist — the documents that must be in hand before closing.
       Each entry points at the documents above that satisfy it, so the readiness
       panel stays in sync with uploads automatically.
       ---------------------------------------------------------------------- */
    var CLOSING = [
        { id: 'closing.title', label: 'Complete chain-of-title documents', docs: ['title.story', 'title.writers', 'title.director', 'title.underlying', 'title.copyright'] },
        { id: 'closing.crew', label: 'Executed cast and crew agreements / NOCs', docs: ['crew.director', 'crew.dop', 'crew.writers', 'crew.cast', 'crew.composer', 'crew.lyricist', 'crew.singers', 'crew.editor', 'crew.designer', 'crew.vfx'] },
        { id: 'closing.music', label: 'Complete music rights documentation', docs: ['music.creators', 'music.score', 'music.masters'] },
        { id: 'closing.locations', label: 'Location releases / NOCs and production permissions', docs: ['locations.releases'] },
        { id: 'closing.thirdparty', label: 'Third-party content clearances', docs: ['thirdparty.archival', 'thirdparty.stock', 'thirdparty.photos', 'thirdparty.artwork', 'thirdparty.marks', 'thirdparty.press', 'thirdparty.music', 'thirdparty.clips'], anyOf: true, optional: true },
        { id: 'closing.cbfc', label: 'CBFC Certificate', docs: ['cbfc.certificate'] },
        { id: 'closing.distribution', label: 'Existing distribution / licensing agreements, if any', docs: ['distribution.agreements'], optional: true },
        { id: 'closing.encumbrance', label: 'No Encumbrance Declaration', docs: ['finance.noEncumbrance'] },
        { id: 'closing.dues', label: 'No Dues Declaration', docs: ['dues.declaration'] },
        { id: 'closing.litigation', label: 'No Litigation / Claims Declaration', docs: ['litigation.declaration'] },
        { id: 'closing.ownership', label: 'Seller’s confirmation of clear and lawful ownership', docs: ['distribution.ownership'] },
        { id: 'closing.authorisation', label: 'Corporate approval / authorisation for the transfer', docs: ['seller.resolution', 'seller.signatory'] }
    ];

    /* -------------------------------------------------------------------------
       Partner profile — the form shown above the document sections.
       ---------------------------------------------------------------------- */
    var PROFILE_FIELDS = [
        { group: 'Selling entity', fields: [
            { id: 'entityName', label: 'Legal name of the Seller', type: 'text', required: true, placeholder: 'As on the Certificate of Incorporation' },
            { id: 'entityType', label: 'Entity type', type: 'select', required: true, options: ['Private Limited Company', 'Public Limited Company', 'LLP', 'Partnership Firm', 'Proprietorship', 'Individual', 'Other'] },
            { id: 'cin', label: 'CIN / LLPIN', type: 'text', required: false, placeholder: 'U74999MH2019PTC123456' },
            { id: 'pan', label: 'PAN', type: 'text', required: true, placeholder: 'AAACS1234A', transform: 'upper' },
            { id: 'gstin', label: 'GSTIN', type: 'text', required: false, placeholder: '27AAACS1234A1Z5', transform: 'upper' },
            { id: 'registeredAddress', label: 'Registered address', type: 'textarea', required: true, wide: true }
        ]},
        { group: 'Authorised signatory', fields: [
            { id: 'signatoryName', label: 'Full name', type: 'text', required: true },
            { id: 'signatoryDesignation', label: 'Designation', type: 'text', required: true, placeholder: 'Director / Designated Partner' },
            { id: 'signatoryEmail', label: 'Email', type: 'email', required: true },
            { id: 'signatoryPhone', label: 'Phone', type: 'tel', required: true }
        ]},
        { group: 'The film', fields: [
            { id: 'filmTitle', label: 'Film title', type: 'text', required: true },
            { id: 'filmLanguage', label: 'Language(s)', type: 'text', required: true },
            { id: 'filmYear', label: 'Year of production', type: 'text', required: true, placeholder: '2025' },
            { id: 'filmRuntime', label: 'Runtime (minutes)', type: 'text', required: false },
            { id: 'cbfcNumber', label: 'CBFC certificate number', type: 'text', required: false },
            { id: 'rightsOffered', label: 'Rights offered for sale / assignment', type: 'textarea', required: true, wide: true, placeholder: 'Territories, media, term, exclusivity' }
        ]},
        { group: 'Disclosures', fields: [
            { id: 'depictsRealPersons', label: 'The film is based on, or depicts, real persons or real-life events', type: 'checkbox' },
            { id: 'hasEncumbrances', label: 'There are existing liens, charges, pledges or third-party interests in the film', type: 'checkbox' },
            { id: 'hasDistribution', label: 'Distribution or licensing rights have already been granted to a third party', type: 'checkbox' },
            { id: 'hasLitigation', label: 'There is pending or threatened litigation, or any claim or notice, relating to the film', type: 'checkbox' },
            { id: 'disclosures', label: 'Details of everything ticked above', type: 'textarea', required: false, wide: true, placeholder: 'Anything disclosed here is carved out of the declarations below.' }
        ]},
        { group: 'Seller confirmations', fields: [
            { id: 'confirmOwnership', label: 'The Seller is the sole and lawful owner of the film and of the rights offered for transfer.', type: 'checkbox', required: true },
            { id: 'confirmEncumbrance', label: 'The film and the rights being transferred are free from encumbrance and third-party claims, except as disclosed above.', type: 'checkbox', required: true },
            { id: 'confirmDues', label: 'No cast, crew, vendor, music or financier dues remain outstanding, except as disclosed above.', type: 'checkbox', required: true },
            { id: 'confirmLitigation', label: 'No claims or proceedings affecting the film or the rights are pending or threatened, except as disclosed above.', type: 'checkbox', required: true },
            { id: 'confirmAccuracy', label: 'The information and documents submitted are true, complete and accurate to the best of the signatory’s knowledge.', type: 'checkbox', required: true }
        ]}
    ];

    /* -------------------------------------------------------------------------
       Lookups and helpers
       ---------------------------------------------------------------------- */
    var byId = {};
    SECTIONS.forEach(function (section) {
        section.docs.forEach(function (doc) {
            doc.section = section.id;
            doc.sectionNo = section.no;
            doc.expect = doc.expect || {};
            byId[doc.id] = doc;
        });
    });

    function allDocs() {
        return SECTIONS.reduce(function (acc, s) { return acc.concat(s.docs); }, []);
    }

    /* A section can be switched off by a profile answer (section 7 is the only
       one today). Sections with no condition are always live. */
    function sectionApplies(section, profile) {
        if (!section.conditional) return true;
        var key = section.conditional.replace(/^profile\./, '');
        return !!(profile && profile[key]);
    }

    function requiredDocs(profile) {
        return SECTIONS.filter(function (s) { return sectionApplies(s, profile); })
            .reduce(function (acc, s) {
                return acc.concat(s.docs.filter(function (d) { return d.required; }));
            }, []);
    }

    /* Overlay template-derived rules onto a document's expectations. This is how
       the per-document checks from the templates get added later — nothing else
       in the portal needs to change. */
    function applyTemplate(docId, expectations) {
        var doc = byId[docId];
        if (!doc) return false;
        Object.keys(expectations || {}).forEach(function (key) {
            doc.expect[key] = expectations[key];
        });
        return true;
    }

    SPX.checklist = {
        sections: SECTIONS,
        closing: CLOSING,
        profileFields: PROFILE_FIELDS,
        identifiers: ID,
        get: function (id) { return byId[id] || null; },
        all: allDocs,
        sectionApplies: sectionApplies,
        requiredDocs: requiredDocs,
        applyTemplate: applyTemplate
    };
})(window);
