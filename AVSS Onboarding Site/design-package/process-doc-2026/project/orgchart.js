/* ──────────────────────────────────────────────────────────────────────────
   AVSS Shared Services Org Chart — SEED DATA
   --------------------------------------------------------------------------
   Defines a single global: window.AVSS_ORG.

   This is the *default* org structure (Q2 2026, from "AV Org Chart - Q2 2026
   v3.pdf"). At runtime the app loads any Manager-saved structure from
   localStorage; if none exists it deep-clones this seed. A "Reset to default"
   action in Manager mode restores this seed. When migrating into the Instrata
   project tools app, this file stays as the seed and the getOrg/saveOrg
   persistence helpers (in Process Doc.html) get swapped for backend calls.

   Shape:
     AVSS_ORG = {
       leadership: [ { id, name, title } ],          // header row
       columns: [ {                                   // top-level divisions
         id, label, lead,
         buckets: [ {                                 // a group of people
           id, label, accent,                         // accent = color tag
           sections: [ {                              // sub-group (may be 1)
             id, label,                               // '' label = no header
             people: [ { id, name, title, location, tbd } ]
           } ]
         } ]
       } ]
     }
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  let _n = 0;
  const uid = (p) => p + (++_n);

  // person / section / bucket builders
  const P = (name, title, location, tbd) => ({
    id: uid('p'), name: name, title: title, location: location || '', tbd: !!tbd
  });
  const S = (label, people) => ({ id: uid('s'), label: label || '', people: people || [] });
  const B = (label, accent, sections) => ({
    id: uid('b'), label: label, accent: accent || '', sections: sections || []
  });

  window.AVSS_ORG = {
    leadership: [
      { id: uid('ld'), name: 'Lee Thompson',  title: 'Director of AV Solutions',            location: '' },
      { id: uid('ld'), name: 'Seth Powell',   title: 'Director of AV Engineering / Design',  location: '' },
      { id: uid('ld'), name: 'James Stuart',  title: 'AV Operations Manager',                location: '' }
    ],

    columns: [
      /* ── Engineering & Design (reports to Seth Powell) ───────────────── */
      {
        id: uid('c'),
        label: 'Engineering & Design',
        lead: 'Seth Powell',
        buckets: [
          B('Pre-Sales', 'eng', [
            S('', [
              P('Isaac Garner',  'Pre-Sales Engineering Manager',     'Raleigh, NC'),
              P('Shaun Lee',     'AV Design Engineer',                'Myrtle Beach, SC'),
              P('Erik Benson',   'AV Design Engineer',                'Raleigh, NC'),
              P('Garry Gilchrist','AV Design Engineer',               'Charlotte, NC'),
              P('Johnny Price',  'AV / L2 Design Engineer / Estimator','Charleston, SC'),
              P('Kelina Bauman', 'AV Design Engineer',                'Raleigh, NC'),
              P('Jason Price',   'AV Design Engineer',                'Garfield, AR'),
              P('Tim Giguere',   'AV Design Engineer',                'Charlotte, NC')
            ])
          ]),
          B('Post-Sales', 'eng', [
            S('', [
              P('Chris Dunegan',  'Post-Sales Engineering Manager', 'Charlotte, NC'),
              P('Matt Davis',     'AV Design Engineer',             'Myrtle Beach, SC'),
              P('Harold Boulder', 'AV Design Engineer',             'Charlotte, NC'),
              P('Tim Gant',       'AV Design Engineer',             'Kouts, IN'),
              P('Miriam Gallegos','AV CAD Technician',              'Raleigh, NC'),
              P('TBD',            'AV Training Engineer',           '', true)
            ])
          ]),
          B('Programming', 'eng', [
            S('', [
              P('Chris Garrett',    'AV Programming Manager', 'Raleigh, NC'),
              P('Richard Blaylock', 'AV Programmer',          'Wilmington, NC')
            ])
          ]),
          B('Managed Services', 'eng', [
            S('', [
              P('Jerry Bates', 'AV Managed Services Engineer', '')
            ])
          ])
        ]
      },

      /* ── Operations (reports to James Stuart) ────────────────────────── */
      {
        id: uid('c'),
        label: 'Operations',
        lead: 'James Stuart',
        buckets: [
          B('Instrata SE - Raleigh', 'se', [
            S('AV Project Manager', [
              P('Stephen Kachur', 'AV Project Manager'),
              P('Josh Sluss',     'AV Project Manager')
            ]),
            S('AV Field Engineers / Technicians', [
              P('Sam Sluss',    'AV Field Engineer'),
              P('Wes O’Quinn', 'AV Field Engineer'),
              P('TBD',          'AV Field Engineer', '', true),
              P('Dave Murano',  'AV Lead Technician'),
              P('Kris McKenzie','AV Lead Technician'),
              P('Stephen Lines','AV Lead Technician'),
              P('Al Hauser',    'AV Lead Technician'),
              P('Neil Turner',  'AV Lead Technician'),
              P('David Toth',   'AV Field Technician'),
              P('Benny Ardent', 'AV Field Technician'),
              P('Dustin Sluss', 'AV Field Technician'),
              P('Zack Lines',   'AV Field Technician'),
              P('John Fuller',  'AV Field Technician'),
              P('Ben Ahern',    'AV Field Technician')
            ]),
            S('Service', [
              P('Owen Casino', 'AV Service Manager')
            ])
          ]),
          B('Instrata SE - Charlotte', 'se', [
            S('AV Project Manager', [
              P('Erwin Eisenbraun', 'AV Project Manager')
            ]),
            S('AV Field Engineers / Technicians', [
              P('Ed Eisenbraun', 'AV Field Engineer'),
              P('TBD',           'AV Field Engineer', '', true),
              P('Bob Krause',    'AV Lead Technician'),
              P('Brian Gluf',    'AV Field Technician'),
              P('TBD',           'AV Field Technician', '', true),
              P('TBD',           'AV Field Technician', '', true)
            ]),
            S('Service', [
              P('Martin Benfield', 'AV Service Engineer')
            ])
          ]),
          B('Instrata SE - Myrtle Beach', 'se', [
            S('AV Field Engineers / Technicians / Service', [
              P('Kevin Green', 'AV Field Engineer'),
              P('Chris Bernal','AV Lead Technician')
            ])
          ]),
          B('Instrata SE - Charleston', 'se', [
            S('AV Project Manager', []),
            S('AV Field Engineers / Technicians', []),
            S('Service', [])
          ]),
          B('Instrata NE', 'ne', [
            S('AV Project Manager', [
              P('Julian McGilloway', 'AV Project Manager')
            ]),
            S('AV Field Engineers / Technicians', [
              P('TBD', 'AV Field Engineer', '', true),
              P('TBD', 'AV Lead Technician', '', true),
              P('TBD', 'AV Lead Technician', '', true)
            ]),
            S('Service', [
              P('TBD', 'AV Service Engineer', '', true)
            ])
          ]),
          B('Instrata MA - Richmond', 'ma', [
            S('AV Project Manager', [
              P('Chris Williams', 'AV Project Manager')
            ]),
            S('AV Field Engineers / Technicians', [
              P('Andrew DeWitt',   'AV Field Engineer'),
              P('Keenan Burant',   'AV Field Engineer'),
              P('Jon Poucher',     'AV Lead Technician'),
              P('Sean Dart',       'AV Lead Technician'),
              P('Gilberto Andino', 'AV Lead Technician'),
              P('Devin Clay',      'AV Technician')
            ]),
            S('Service', [
              P('TBD', 'AV Service Engineer', '', true)
            ])
          ]),
          B('Instrata MA - Chantilly', 'ma', [
            S('AV Field Engineers / Technicians', [
              P('TBD', 'AV Lead Technician', '', true),
              P('TBD', 'AV Lead Technician', '', true)
            ]),
            S('Service', [
              P('TBD', 'AV Service Engineer', '', true)
            ])
          ]),
          B('Instrata MA - Baltimore', 'ma', [
            S('AV Project Manager', []),
            S('AV Field Engineers / Technicians', []),
            S('Service', [])
          ]),
          B('Instrata SW', 'sw', [
            S('AV Field Engineers / Technicians', [
              P('Dan Bridges',     'AV Field Engineer'),
              P('Michael Gessert', 'AV Lead Technician'),
              P('TBD',             'AV Lead Technician', '', true)
            ]),
            S('Service', [
              P('TBD', 'AV Service Engineer', '', true)
            ])
          ])
        ]
      }
    ]
  };
})();
