begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Identity provenance is recorded in catalogue-manifest.csv. Variant arrays are
-- fallback choices for V1 pickers. They do not claim hardware compatibility.
create unique index if not exists tablet_brands_v2_normalized_name
 on public.tablet_brands_v1 (lower(btrim(name)));
create unique index if not exists tablet_models_v2_normalized_name
 on public.tablet_models_v1 (brand_id, lower(btrim(name)));
create unique index if not exists tablet_models_v2_one_other
 on public.tablet_models_v1 (brand_id) where other;

with seed(name,sort_order) as (values
  ('Acer',20),
  ('Alcatel',21),
  ('Amazon',22),
  ('Apple',23),
  ('Asus',24),
  ('Datawind',25),
  ('Google',26),
  ('Honor',27),
  ('Huawei',28),
  ('iBall',29),
  ('Infinix',30),
  ('iQOO',31),
  ('itel',32),
  ('Lava',33),
  ('Lenovo',34),
  ('Micromax',35),
  ('Microsoft',36),
  ('Motorola',37),
  ('Nokia',38),
  ('OnePlus',39),
  ('Oppo',40),
  ('POCO',41),
  ('realme',42),
  ('Redmi',43),
  ('Samsung',44),
  ('Swipe',45),
  ('Tecno',46),
  ('Vivo',47),
  ('Xiaomi',48)
)
insert into public.tablet_brands_v1 (name,sort_order)
select name,sort_order from seed
on conflict (lower(btrim(name))) do nothing;

update public.tablet_brands_v1 set sort_order=2147483647 where name='Other' and sort_order<>2147483647;

with seed(brand,name,aliases,sort_order,family,generation) as (values
  ('Acer','Iconia One 10',array['Acer Iconia One 10']::text[],10,'Iconia','Not specified'),
  ('Acer','Iconia One 7',array['Acer Iconia One 7']::text[],11,'Iconia','Not specified'),
  ('Acer','Iconia One 8',array['Acer Iconia One 8']::text[],12,'Iconia','Not specified'),
  ('Acer','Iconia Tab 10',array['Acer Iconia Tab 10']::text[],13,'Iconia','Not specified'),
  ('Alcatel','1T 10',array['Alcatel 1T 10']::text[],14,'Alcatel 1T','2018'),
  ('Alcatel','1T 7',array['Alcatel 1T 7']::text[],15,'Alcatel 1T','2018'),
  ('Alcatel','3T 10',array['Alcatel 3T 10']::text[],16,'Alcatel 3T','Not specified'),
  ('Alcatel','3T 8',array['Alcatel 3T 8']::text[],17,'Alcatel 3T','2018'),
  ('Alcatel','JOY TAB',array['Alcatel Joy Tab']::text[],18,'JOY TAB','Not specified'),
  ('Alcatel','JOY TAB 2',array['Alcatel Joy Tab 2']::text[],19,'JOY TAB','Not specified'),
  ('Amazon','Fire 7 (2017)',array[]::text[],20,'Fire','2017'),
  ('Amazon','Fire 7 (2019)',array[]::text[],21,'Fire','2019'),
  ('Amazon','Fire 7 (2022)',array[]::text[],22,'Fire','2022'),
  ('Amazon','Fire HD 10 (2017)',array[]::text[],23,'Fire HD','2017'),
  ('Amazon','Fire HD 10 (2019)',array[]::text[],24,'Fire HD','2019'),
  ('Amazon','Fire HD 10 (2021)',array[]::text[],25,'Fire HD','2021'),
  ('Amazon','Fire HD 10 (2023)',array[]::text[],26,'Fire HD','2023'),
  ('Amazon','Fire HD 10 Plus (2021)',array[]::text[],27,'Fire HD','2021'),
  ('Amazon','Fire HD 8 (2018)',array[]::text[],28,'Fire HD','2018'),
  ('Amazon','Fire HD 8 (2020)',array[]::text[],29,'Fire HD','2020'),
  ('Amazon','Fire HD 8 (2022)',array[]::text[],30,'Fire HD','2022'),
  ('Amazon','Fire HD 8 (2024)',array[]::text[],31,'Fire HD','2024'),
  ('Amazon','Fire HD 8 Plus (2022)',array[]::text[],32,'Fire HD','2022'),
  ('Amazon','Fire Max 11',array[]::text[],33,'Fire HD','2023'),
  ('Apple','iPad (3rd generation)',array['iPad 3']::text[],34,'iPad','2012'),
  ('Apple','iPad (4th generation)',array[]::text[],35,'iPad','2012'),
  ('Apple','iPad (5th generation)',array[]::text[],36,'iPad','2017'),
  ('Apple','iPad (6th generation)',array[]::text[],37,'iPad','2018'),
  ('Apple','iPad (7th generation)',array[]::text[],38,'iPad','2019'),
  ('Apple','iPad (8th generation)',array[]::text[],39,'iPad','2020'),
  ('Apple','iPad (A16)',array['iPad (A16, 11-inch)']::text[],40,'iPad','2025'),
  ('Apple','iPad 2',array[]::text[],41,'iPad','2011'),
  ('Apple','iPad Air',array['iPad Air (1st generation)']::text[],42,'iPad Air','2013'),
  ('Apple','iPad Air (3rd generation)',array[]::text[],43,'iPad Air','2019'),
  ('Apple','iPad Air (4th generation)',array[]::text[],44,'iPad Air','2020'),
  ('Apple','iPad Air 11-inch (M2)',array[]::text[],45,'iPad Air','2024'),
  ('Apple','iPad Air 11-inch (M3)',array[]::text[],46,'iPad Air','2025'),
  ('Apple','iPad Air 13-inch (M2)',array[]::text[],47,'iPad Air','2024'),
  ('Apple','iPad Air 13-inch (M3)',array[]::text[],48,'iPad Air','2025'),
  ('Apple','iPad Air 2',array[]::text[],49,'iPad Air','2014'),
  ('Apple','iPad Pro (10.5-inch)',array['iPad Pro 10.5-inch']::text[],50,'iPad Pro','2017'),
  ('Apple','iPad Pro (12.9-inch)',array['iPad Pro 12.9-inch (1st generation)']::text[],51,'iPad Pro','2015'),
  ('Apple','iPad Pro (9.7-inch)',array['iPad Pro 9.7-inch']::text[],52,'iPad Pro','2016'),
  ('Apple','iPad Pro 11-inch (1st generation)',array[]::text[],53,'iPad Pro','2018'),
  ('Apple','iPad Pro 11-inch (2nd generation)',array[]::text[],54,'iPad Pro','2020'),
  ('Apple','iPad Pro 11-inch (4th generation)',array[]::text[],55,'iPad Pro','2022'),
  ('Apple','iPad Pro 11-inch (M4)',array[]::text[],56,'iPad Pro','2024'),
  ('Apple','iPad Pro 11-inch (M5)',array[]::text[],57,'iPad Pro','2025'),
  ('Apple','iPad Pro 12.9-inch (2nd generation)',array[]::text[],58,'iPad Pro','2017'),
  ('Apple','iPad Pro 12.9-inch (3rd generation)',array[]::text[],59,'iPad Pro','2018'),
  ('Apple','iPad Pro 12.9-inch (4th generation)',array[]::text[],60,'iPad Pro','2020'),
  ('Apple','iPad Pro 12.9-inch (5th generation)',array[]::text[],61,'iPad Pro','2021'),
  ('Apple','iPad Pro 12.9-inch (6th generation)',array[]::text[],62,'iPad Pro','2022'),
  ('Apple','iPad Pro 13-inch (M4)',array[]::text[],63,'iPad Pro','2024'),
  ('Apple','iPad Pro 13-inch (M5)',array[]::text[],64,'iPad Pro','2025'),
  ('Apple','iPad mini',array['iPad mini (1st generation)']::text[],65,'iPad mini','2012'),
  ('Apple','iPad mini (5th generation)',array[]::text[],66,'iPad mini','2019'),
  ('Apple','iPad mini (A17 Pro)',array[]::text[],67,'iPad mini','2024'),
  ('Apple','iPad mini 2',array[]::text[],68,'iPad mini','2013'),
  ('Apple','iPad mini 3',array[]::text[],69,'iPad mini','2014'),
  ('Apple','iPad mini 4',array[]::text[],70,'iPad mini','2015'),
  ('Asus','Transformer 3',array['Asus Transformer 3']::text[],71,'Transformer','Not specified'),
  ('Asus','Transformer Mini T102',array['Asus Transformer Mini']::text[],72,'Transformer','Not specified'),
  ('Asus','ZenPad 10',array['Asus ZenPad 10']::text[],73,'ZenPad','Not specified'),
  ('Asus','ZenPad 3S 10',array['Asus ZenPad 3S 10']::text[],74,'ZenPad','Not specified'),
  ('Asus','ZenPad 7.0',array['Asus ZenPad 7.0']::text[],75,'ZenPad','Not specified'),
  ('Asus','ZenPad 8.0',array['Asus ZenPad 8.0']::text[],76,'ZenPad','Not specified'),
  ('Asus','ZenPad Z8',array['Asus ZenPad Z8']::text[],77,'ZenPad','Not specified'),
  ('Datawind','UbiSlate 10Ci',array['Datawind Ubislate 10Ci']::text[],78,'UbiSlate','Not specified'),
  ('Datawind','UbiSlate 3G7',array['Datawind Ubislate 3G7']::text[],79,'UbiSlate','Not specified'),
  ('Datawind','UbiSlate 7C+',array['Datawind Ubislate 7C+']::text[],80,'UbiSlate','Not specified'),
  ('Datawind','UbiSlate 7Ci',array['Datawind Ubislate 7Ci']::text[],81,'UbiSlate','Not specified'),
  ('Datawind','UbiSlate 7Cx',array[]::text[],82,'UbiSlate','Not specified'),
  ('Datawind','UbiSlate 9Ci',array['Datawind Ubislate 9Ci']::text[],83,'UbiSlate','Not specified'),
  ('Google','Pixel C',array[]::text[],84,'Pixel','Not specified'),
  ('Google','Pixel Tablet',array[]::text[],85,'Pixel','Not specified'),
  ('Honor','Pad 10',array['Honor Pad 10']::text[],86,'Honor Pad','Not specified'),
  ('Honor','Pad 8',array['Honor Pad 8']::text[],87,'Honor Pad','Not specified'),
  ('Honor','Pad 9',array['Honor Pad 9']::text[],88,'Honor Pad','Not specified'),
  ('Honor','Pad X8',array['Honor Pad X8']::text[],89,'Honor Pad','Not specified'),
  ('Honor','Pad X8a',array['Honor Pad X8a']::text[],90,'Honor Pad','Not specified'),
  ('Honor','Pad X9',array['Honor Pad X9']::text[],91,'Honor Pad','Not specified'),
  ('Honor','Pad X9a',array['Honor Pad X9a']::text[],92,'Honor Pad','Not specified'),
  ('Huawei','MatePad 11.5 (2025)',array[]::text[],93,'MatePad','2025'),
  ('Huawei','MatePad Pro 12.6',array['Huawei MatePad Pro 12.6']::text[],94,'MatePad','Not specified'),
  ('Huawei','MatePad Pro 13.2',array['Huawei MatePad Pro 13.2']::text[],95,'MatePad','Not specified'),
  ('Huawei','MatePad SE',array['Huawei MatePad SE']::text[],96,'MatePad','Not specified'),
  ('Huawei','MatePad SE 11',array[]::text[],97,'MatePad','Not specified'),
  ('Huawei','MatePad T 10s',array['Huawei MatePad T10s']::text[],98,'MatePad','Not specified'),
  ('Huawei','MediaPad M2',array['Huawei MediaPad M2']::text[],99,'MediaPad','Not specified'),
  ('Huawei','MediaPad M5 10.8',array[]::text[],100,'MediaPad','Not specified'),
  ('Huawei','MediaPad M5 8.4',array[]::text[],101,'MediaPad','Not specified'),
  ('Huawei','MediaPad M5 lite',array['Huawei MediaPad M5 Lite']::text[],102,'MediaPad','Not specified'),
  ('Huawei','MediaPad T3',array['Huawei MediaPad T3']::text[],103,'MediaPad','Not specified'),
  ('Huawei','MediaPad T5',array['Huawei MediaPad T5']::text[],104,'MediaPad','Not specified'),
  ('Infinix','XPAD',array['Infinix XPAD']::text[],105,'XPAD','Not specified'),
  ('Infinix','XPAD 20',array['Infinix XPAD 20']::text[],106,'XPAD','Not specified'),
  ('Lava','Aura',array['Lava Aura Tab']::text[],107,'Lava tablet','2021'),
  ('Lava','Ivory',array['Lava Ivory Pad']::text[],108,'Lava tablet','2021'),
  ('Lava','IvoryS',array['Lava Ivory S']::text[],109,'Ivory','Not specified'),
  ('Lava','Magnum XL',array['Lava Magnum XL']::text[],110,'Lava tablet','2021'),
  ('Lenovo','Tab 4 10',array['Lenovo Tab 4 10']::text[],111,'Lenovo Tab 4','Not specified'),
  ('Lenovo','Tab 4 10 Plus',array['Lenovo Tab 4 10 Plus']::text[],112,'Lenovo Tab 4','Not specified'),
  ('Lenovo','Tab 4 8',array['Lenovo Tab 4 8']::text[],113,'Lenovo Tab 4','Not specified'),
  ('Lenovo','Tab 4 8 Plus',array['Lenovo Tab 4 8 Plus']::text[],114,'Lenovo Tab 4','Not specified'),
  ('Lenovo','Tab E10',array['Lenovo Tab E10']::text[],115,'Lenovo Tab E','Not specified'),
  ('Lenovo','Tab E7',array['Lenovo Tab E7']::text[],116,'Lenovo Tab E','Not specified'),
  ('Lenovo','Tab E8',array['Lenovo Tab E8']::text[],117,'Lenovo Tab E','Not specified'),
  ('Lenovo','Tab Extreme',array['Lenovo Tab Extreme']::text[],118,'Lenovo Tab','Not specified'),
  ('Lenovo','Tab K10',array['Lenovo Tab K10']::text[],119,'Lenovo Tab K','Not specified'),
  ('Lenovo','Tab M10 (3rd Gen)',array['Lenovo Tab M10 (3rd Gen)']::text[],120,'Lenovo Tab M','Not specified'),
  ('Lenovo','Tab M10 (FHD)',array[]::text[],121,'Lenovo Tab M','Not specified'),
  ('Lenovo','Tab M10 (HD)',array['Lenovo Tab M10 HD']::text[],122,'Lenovo Tab M','Not specified'),
  ('Lenovo','Tab M10 5G',array[]::text[],123,'Lenovo Tab','Not specified'),
  ('Lenovo','Tab M10 FHD Plus',array['Lenovo Tab M10 FHD Plus']::text[],124,'Lenovo Tab M','Not specified'),
  ('Lenovo','Tab M10 HD (2nd Gen)',array[]::text[],125,'Lenovo Tab M','Not specified'),
  ('Lenovo','Tab M10 Plus (3rd Gen)',array['Lenovo Tab M10 Plus (3rd Gen)']::text[],126,'Lenovo Tab M','Not specified'),
  ('Lenovo','Tab M11',array['Lenovo Tab M11']::text[],127,'Lenovo Tab','Not specified'),
  ('Lenovo','Tab M7',array['Lenovo Tab M7']::text[],128,'Lenovo Tab M','Not specified'),
  ('Lenovo','Tab M7 (3rd Gen)',array['Lenovo Tab M7 (3rd Gen)']::text[],129,'Lenovo Tab M','Not specified'),
  ('Lenovo','Tab M8',array['Lenovo Tab M8']::text[],130,'Lenovo Tab M','Not specified'),
  ('Lenovo','Tab M8 (3rd Gen)',array['Lenovo Tab M8 (3rd Gen)']::text[],131,'Lenovo Tab M','Not specified'),
  ('Lenovo','Tab M8 (4th Gen)',array['Lenovo Tab M8 (4th Gen)']::text[],132,'Lenovo Tab M','Not specified'),
  ('Lenovo','Tab M9',array['Lenovo Tab M9']::text[],133,'Lenovo Tab M','Not specified'),
  ('Lenovo','Tab P11',array['Lenovo Tab P11']::text[],134,'Lenovo Tab P','Not specified'),
  ('Lenovo','Tab P11 (2nd Gen)',array['Lenovo Tab P11 (2nd Gen)']::text[],135,'Lenovo Tab P','Not specified'),
  ('Lenovo','Tab P11 Plus',array['Lenovo Tab P11 Plus']::text[],136,'Lenovo Tab P','Not specified'),
  ('Lenovo','Tab P11 Pro',array['Lenovo Tab P11 Pro']::text[],137,'Lenovo Tab P','Not specified'),
  ('Lenovo','Tab P11 Pro Gen 2',array['Lenovo Tab P11 Pro Gen 2']::text[],138,'Lenovo Tab P','Not specified'),
  ('Lenovo','Tab P12',array['Lenovo Tab P12']::text[],139,'Lenovo Tab','Not specified'),
  ('Lenovo','Tab P12 Pro',array['Lenovo Tab P12 Pro']::text[],140,'Lenovo Tab P','Not specified'),
  ('Lenovo','Tab Plus',array['Lenovo Tab Plus']::text[],141,'Lenovo Tab','Not specified'),
  ('Lenovo','Tab V7',array['Lenovo Tab V7']::text[],142,'Lenovo Tab','2019'),
  ('Lenovo','Yoga Smart Tab',array['Lenovo Yoga Smart Tab']::text[],143,'Lenovo Yoga Tab','Not specified'),
  ('Lenovo','Yoga Tab 11',array['Lenovo Yoga Tab 11']::text[],144,'Lenovo Yoga Tab','Not specified'),
  ('Lenovo','Yoga Tab 13',array['Lenovo Yoga Tab 13']::text[],145,'Lenovo Yoga Tab','Not specified'),
  ('Lenovo','Yoga Tab 3 10-inch',array[]::text[],146,'Lenovo Yoga Tab','Not specified'),
  ('Lenovo','Yoga Tab 3 8-inch',array[]::text[],147,'Lenovo Yoga Tab','Not specified'),
  ('Lenovo','Yoga Tab 3 Plus',array[]::text[],148,'Lenovo Yoga Tab','Not specified'),
  ('Lenovo','Yoga Tab 3 Pro',array['Lenovo Yoga Tab 3 Pro']::text[],149,'Lenovo Yoga Tab','Not specified'),
  ('Micromax','Canvas Plex Tab',array['Micromax Canvas Plex']::text[],150,'Canvas','Not specified'),
  ('Micromax','Canvas Tab P701',array['Micromax Canvas Tab P701']::text[],151,'Canvas Tab','Not specified'),
  ('Micromax','Canvas Tab P702',array['Micromax Canvas Tab P702']::text[],152,'Canvas Tab','Not specified'),
  ('Micromax','Funbook Pro',array['Micromax Funbook Pro']::text[],153,'Funbook','Not specified'),
  ('Micromax','Funbook Talk P360',array['Micromax Funbook Talk']::text[],154,'Funbook','Not specified'),
  ('Microsoft','Surface Go',array[]::text[],155,'Surface Go','2018'),
  ('Microsoft','Surface Go 2',array[]::text[],156,'Surface Go','2020'),
  ('Microsoft','Surface Go 3',array[]::text[],157,'Surface Go','2021'),
  ('Microsoft','Surface Go 4',array[]::text[],158,'Surface Go','2023'),
  ('Microsoft','Surface Pro 10 for Business',array['Surface Pro 10']::text[],159,'Surface Pro','2024'),
  ('Microsoft','Surface Pro 11th Edition (Snapdragon)',array['Surface Pro 11']::text[],160,'Surface Pro','2024'),
  ('Microsoft','Surface Pro 6',array[]::text[],161,'Surface Pro','2018'),
  ('Microsoft','Surface Pro 7',array[]::text[],162,'Surface Pro','2019'),
  ('Microsoft','Surface Pro 7+',array[]::text[],163,'Surface Pro','2021'),
  ('Microsoft','Surface Pro 8',array[]::text[],164,'Surface Pro','2021'),
  ('Microsoft','Surface Pro 9',array[]::text[],165,'Surface Pro','2022'),
  ('Microsoft','Surface Pro X',array[]::text[],166,'Surface Pro','Not specified'),
  ('Motorola','Moto Pad 60 Neo',array[]::text[],167,'Moto Pad','Not specified'),
  ('Motorola','Moto Pad 60 Pro',array[]::text[],168,'Moto Pad','Not specified'),
  ('Motorola','Moto Pad 70',array[]::text[],169,'Moto Pad','Not specified'),
  ('Motorola','Moto Pad 70 Groove',array[]::text[],170,'Moto Pad','Not specified'),
  ('Motorola','Moto Pad 70 Pro',array[]::text[],171,'Moto Pad','Not specified'),
  ('Motorola','Moto Tab G20',array['Motorola Moto Tab G20']::text[],172,'Moto Tab','Not specified'),
  ('Motorola','Moto Tab G62',array['Motorola Moto Tab G62']::text[],173,'Moto Tab','Not specified'),
  ('Motorola','Moto Tab G70',array['Motorola Moto Tab G70']::text[],174,'Moto Tab','Not specified'),
  ('Nokia','T10',array['Nokia T10']::text[],175,'Nokia T','Not specified'),
  ('Nokia','T20',array['Nokia T20']::text[],176,'Nokia T','Not specified'),
  ('Nokia','T21',array['Nokia T21']::text[],177,'Nokia T','Not specified'),
  ('OnePlus','OnePlus Pad',array[]::text[],178,'OnePlus Pad','Not specified'),
  ('OnePlus','OnePlus Pad 2',array[]::text[],179,'OnePlus Pad','Not specified'),
  ('OnePlus','OnePlus Pad 3',array[]::text[],180,'OnePlus Pad','Not specified'),
  ('OnePlus','OnePlus Pad 4',array[]::text[],181,'OnePlus Pad','Not specified'),
  ('OnePlus','OnePlus Pad Go',array[]::text[],182,'OnePlus Pad','Not specified'),
  ('OnePlus','OnePlus Pad Go 2',array[]::text[],183,'OnePlus Pad','Not specified'),
  ('OnePlus','OnePlus Pad Lite',array[]::text[],184,'OnePlus Pad','Not specified'),
  ('Oppo','OPPO Pad 2',array['Oppo Pad 2']::text[],185,'OPPO Pad','Not specified'),
  ('Oppo','OPPO Pad 3',array['Oppo Pad 3']::text[],186,'OPPO Pad','Not specified'),
  ('Oppo','OPPO Pad 3 Pro',array[]::text[],187,'OPPO Pad','Not specified'),
  ('Oppo','OPPO Pad Air',array['Oppo Pad Air']::text[],188,'OPPO Pad','Not specified'),
  ('Oppo','OPPO Pad Neo',array['Oppo Pad Neo']::text[],189,'OPPO Pad','Not specified'),
  ('Oppo','OPPO Pad SE',array[]::text[],190,'OPPO Pad','Not specified'),
  ('POCO','POCO Pad',array[]::text[],191,'POCO Pad','Not specified'),
  ('POCO','POCO Pad M1',array[]::text[],192,'POCO Pad','Not specified'),
  ('POCO','POCO Pad X1',array[]::text[],193,'POCO Pad','Not specified'),
  ('Redmi','Redmi Pad',array[]::text[],194,'Redmi Pad','Not specified'),
  ('Redmi','Redmi Pad 2',array[]::text[],195,'Redmi Pad','Not specified'),
  ('Redmi','Redmi Pad 2 Pro',array[]::text[],196,'Redmi Pad','Not specified'),
  ('Redmi','Redmi Pad Pro',array[]::text[],197,'Redmi Pad','Not specified'),
  ('Redmi','Redmi Pad SE',array[]::text[],198,'Redmi Pad','Not specified'),
  ('Redmi','Redmi Pad SE 8.7',array[]::text[],199,'Redmi Pad','Not specified'),
  ('Samsung','Galaxy J Max',array['Galaxy Tab J Max']::text[],200,'Galaxy J','2016'),
  ('Samsung','Galaxy Tab 3 Lite',array[]::text[],201,'Galaxy Tab','Not specified'),
  ('Samsung','Galaxy Tab A 10.1 (2016)',array['Galaxy Tab A (2016)']::text[],202,'Galaxy Tab A','Not specified'),
  ('Samsung','Galaxy Tab A 10.1 (2019)',array[]::text[],203,'Galaxy Tab A','2019'),
  ('Samsung','Galaxy Tab A 10.5 (2018)',array[]::text[],204,'Galaxy Tab A','2018'),
  ('Samsung','Galaxy Tab A 8.0 (2017)',array[]::text[],205,'Galaxy Tab A','2017'),
  ('Samsung','Galaxy Tab A 8.0 (2019)',array[]::text[],206,'Galaxy Tab A','2019'),
  ('Samsung','Galaxy Tab A11',array[]::text[],207,'Galaxy Tab A','Not specified'),
  ('Samsung','Galaxy Tab A11+',array[]::text[],208,'Galaxy Tab A','Not specified'),
  ('Samsung','Galaxy Tab A7 (2020)',array[]::text[],209,'Galaxy Tab A','2020'),
  ('Samsung','Galaxy Tab A7 Lite',array[]::text[],210,'Galaxy Tab A','2021'),
  ('Samsung','Galaxy Tab A8 (2021)',array[]::text[],211,'Galaxy Tab A','2021'),
  ('Samsung','Galaxy Tab A9+',array[]::text[],212,'Galaxy Tab A','2023'),
  ('Samsung','Galaxy Tab Active Pro',array[]::text[],213,'Galaxy Tab Active','Not specified'),
  ('Samsung','Galaxy Tab Active3',array[]::text[],214,'Galaxy Tab Active','Not specified'),
  ('Samsung','Galaxy Tab Active4 Pro',array[]::text[],215,'Galaxy Tab Active','Not specified'),
  ('Samsung','Galaxy Tab Active5',array[]::text[],216,'Galaxy Tab Active','Not specified'),
  ('Samsung','Galaxy Tab E 8.0',array[]::text[],217,'Galaxy Tab E','Not specified'),
  ('Samsung','Galaxy Tab E 9.6',array[]::text[],218,'Galaxy Tab E','Not specified'),
  ('Samsung','Galaxy Tab Iris',array[]::text[],219,'Galaxy Tab','2016'),
  ('Samsung','Galaxy Tab S10 FE',array[]::text[],220,'Galaxy Tab S','2025'),
  ('Samsung','Galaxy Tab S10 FE+',array[]::text[],221,'Galaxy Tab S','2025'),
  ('Samsung','Galaxy Tab S10 Ultra',array[]::text[],222,'Galaxy Tab S','2024'),
  ('Samsung','Galaxy Tab S10+',array[]::text[],223,'Galaxy Tab S','2024'),
  ('Samsung','Galaxy Tab S11',array[]::text[],224,'Galaxy Tab S','Not specified'),
  ('Samsung','Galaxy Tab S11 Ultra',array[]::text[],225,'Galaxy Tab S','Not specified'),
  ('Samsung','Galaxy Tab S12 Ultra',array[]::text[],226,'Galaxy Tab S','Not specified'),
  ('Samsung','Galaxy Tab S12+',array[]::text[],227,'Galaxy Tab S','Not specified'),
  ('Samsung','Galaxy Tab S2',array[]::text[],228,'Galaxy Tab S','2015'),
  ('Samsung','Galaxy Tab S3',array[]::text[],229,'Galaxy Tab S','2017'),
  ('Samsung','Galaxy Tab S4',array[]::text[],230,'Galaxy Tab S','2018'),
  ('Samsung','Galaxy Tab S5e',array[]::text[],231,'Galaxy Tab S','2019'),
  ('Samsung','Galaxy Tab S6',array[]::text[],232,'Galaxy Tab S','2019'),
  ('Samsung','Galaxy Tab S6 Lite',array[]::text[],233,'Galaxy Tab S','Not specified'),
  ('Samsung','Galaxy Tab S7',array[]::text[],234,'Galaxy Tab S','2020'),
  ('Samsung','Galaxy Tab S7 FE',array[]::text[],235,'Galaxy Tab S','2021'),
  ('Samsung','Galaxy Tab S7+',array[]::text[],236,'Galaxy Tab S','2020'),
  ('Samsung','Galaxy Tab S8',array[]::text[],237,'Galaxy Tab S','2022'),
  ('Samsung','Galaxy Tab S8 Ultra',array[]::text[],238,'Galaxy Tab S','2022'),
  ('Samsung','Galaxy Tab S8+',array[]::text[],239,'Galaxy Tab S','2022'),
  ('Samsung','Galaxy Tab S9',array[]::text[],240,'Galaxy Tab S','2023'),
  ('Samsung','Galaxy Tab S9 FE',array[]::text[],241,'Galaxy Tab S','2023'),
  ('Samsung','Galaxy Tab S9 FE+',array[]::text[],242,'Galaxy Tab S','2023'),
  ('Samsung','Galaxy Tab S9 Ultra',array[]::text[],243,'Galaxy Tab S','2023'),
  ('Samsung','Galaxy Tab S9+',array[]::text[],244,'Galaxy Tab S','2023'),
  ('Swipe','Slate 2',array['Swipe Slate 2']::text[],245,'Slate','Not specified'),
  ('Swipe','Slate Pro',array['Swipe Slate Pro']::text[],246,'Slate','Not specified'),
  ('Tecno','MEGAPAD 10',array['Tecno Megapad 10']::text[],247,'MEGAPAD','Not specified'),
  ('Tecno','MEGAPAD 11',array['Tecno Megapad 11']::text[],248,'MEGAPAD','Not specified'),
  ('Vivo','Pad',array['Vivo Pad']::text[],249,'vivo Pad','Not specified'),
  ('Vivo','Pad Air',array['Vivo Pad Air']::text[],250,'vivo Pad','Not specified'),
  ('Vivo','Pad SE',array['Vivo Pad SE']::text[],251,'vivo Pad','Not specified'),
  ('Vivo','Pad2',array['Vivo Pad2']::text[],252,'vivo Pad','Not specified'),
  ('Vivo','Pad3',array['Vivo Pad3']::text[],253,'vivo Pad','Not specified'),
  ('Xiaomi','Mi Pad 2',array[]::text[],254,'Mi Pad','Not specified'),
  ('Xiaomi','Mi Pad 3',array[]::text[],255,'Mi Pad','Not specified'),
  ('Xiaomi','Mi Pad 4',array[]::text[],256,'Mi Pad','Not specified'),
  ('Xiaomi','Mi Pad 4 Plus',array[]::text[],257,'Mi Pad','2018'),
  ('Xiaomi','Pad 5',array['Xiaomi Pad 5']::text[],258,'Xiaomi Pad','Not specified'),
  ('Xiaomi','Pad 5 Pro',array['Xiaomi Pad 5 Pro']::text[],259,'Xiaomi Pad','Not specified'),
  ('Xiaomi','Pad 6',array['Xiaomi Pad 6']::text[],260,'Xiaomi Pad','Not specified'),
  ('Xiaomi','Pad 6 Max 14',array['Xiaomi Pad 6 Max']::text[],261,'Xiaomi Pad','Not specified'),
  ('Xiaomi','Pad 6 Pro',array['Xiaomi Pad 6 Pro']::text[],262,'Xiaomi Pad','Not specified'),
  ('Xiaomi','Pad 7',array['Xiaomi Pad 7']::text[],263,'Xiaomi Pad','Not specified'),
  ('Xiaomi','Pad 7 Pro',array['Xiaomi Pad 7 Pro']::text[],264,'Xiaomi Pad','Not specified'),
  ('Xiaomi','Pad 7 Ultra',array['Xiaomi Pad 7 Ultra']::text[],265,'Xiaomi Pad','Not specified'),
  ('iBall','Slide Brisk 4G2',array['iBall Slide Brisk 4G2']::text[],266,'Slide','2017'),
  ('iBall','Slide Cuboid',array['iBall Slide Cuboid']::text[],267,'Slide','Not specified'),
  ('iBall','Slide Q27 4G',array['iBall Slide Q27']::text[],268,'Slide','Not specified'),
  ('iBall','Slide Snap 4G2',array['iBall Slide Snap 4G2']::text[],269,'Slide','Not specified'),
  ('iBall','Slide Wings',array['iBall Slide Wings']::text[],270,'Slide','Not specified'),
  ('iQOO','iQOO Pad',array[]::text[],271,'iQOO Pad','Not specified'),
  ('iQOO','iQOO Pad Air',array[]::text[],272,'iQOO Pad','Not specified'),
  ('itel','Pad One',array['itel Pad 1','itel Pad One']::text[],273,'itel Pad','2023'),
  ('realme','Pad',array['Realme Pad']::text[],274,'realme Pad','Not specified'),
  ('realme','Pad 2',array['Realme Pad 2']::text[],275,'realme Pad','Not specified'),
  ('realme','Pad 2 Lite',array['Realme Pad 2 Lite']::text[],276,'realme Pad','Not specified'),
  ('realme','Pad 3',array['Realme Pad 3']::text[],277,'realme Pad','Not specified'),
  ('realme','Pad Mini',array['Realme Pad Mini']::text[],278,'realme Pad','Not specified'),
  ('realme','Pad X',array['Realme Pad X']::text[],279,'realme Pad','Not specified')
)
insert into public.tablet_models_v1 (brand_id,name,aliases,sort_order,family,generation,screen_inches,storage,connectivity)
select b.id,s.name,s.aliases,s.sort_order,s.family,s.generation,'Not specified',
 array['16 GB','32 GB','64 GB','128 GB','256 GB','512 GB','1 TB','2 TB','Not sure'],
 array['wifi','lte','five_g','unknown']
from seed s join public.tablet_brands_v1 b on lower(btrim(b.name))=lower(btrim(s.brand))
where b.name<>'Other'
on conflict (brand_id,lower(btrim(name))) do nothing;

insert into public.tablet_models_v1 (brand_id,name,sort_order,other,family,generation,screen_inches,storage,connectivity)
select b.id,'Other model',2147483647,true,'Seller-declared','Not specified','Not specified',
 array['16 GB','32 GB','64 GB','128 GB','256 GB','512 GB','1 TB','2 TB','Not sure'],
 array['wifi','lte','five_g','unknown']
from public.tablet_brands_v1 b
where not exists(select 1 from public.tablet_models_v1 m where m.brand_id=b.id and m.other)
on conflict (brand_id) where other do nothing;

update public.tablet_models_v1 set sort_order=2147483647 where other and sort_order<>2147483647;

do $$
begin
 if not exists (select 1 from public.tablet_brands_v1 where name='Other')
  or exists (select 1 from public.tablet_brands_v1 b
   where not exists (select 1 from public.tablet_models_v1 m
    where m.brand_id=b.id and m.other and m.name='Other model'))
  or exists (select 1 from public.tablet_models_v1 m
   join public.tablet_brands_v1 b on b.id=m.brand_id where b.name='Other' and not m.other)
 then raise exception 'Tablet catalogue fallback invariant failed';end if;
end $$;

create or replace function app_security.validate_tablet_v1(p jsonb) returns void language plpgsql security definer set search_path='' as $$
declare keys text[];k text;m public.tablet_models_v1;v text;brand_name text;
 whitespace constant text:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
 optional_keys constant text[]:=array['other_brand','storage_other','ram_other','connectivity_other'];
begin
 keys:=array['selection','session_id','brand_id','model_id','other_model','storage','connectivity','ram','colour','hardware_model_number','condition','screen_touch_status','battery_charging_status','transfer_lock_status','powers_on','repair_history','other_defects','included','stylus_description','keyboard_description','warranty_until','title','description','trade','price_paise','negotiable','pin_code','city_id','locality_id','media_ids','plan_id'];
 if jsonb_typeof(p) is distinct from 'object' or p-(keys||optional_keys)<>'{}' or not(p?&keys) or p->'selection' is distinct from '{"category":"mobiles","subcategory":"tablets","version":1}'::jsonb or p->>'plan_id' is distinct from 'free-v1' then raise exception 'Invalid tablet contract';end if;
 foreach k in array keys loop
  if k not in ('selection','price_paise','negotiable','included','media_ids') and jsonb_typeof(p->k) is distinct from 'string' then raise exception 'Invalid tablet field type';end if;
 end loop;
 if jsonb_typeof(p->'price_paise') is distinct from 'number' or (p->>'price_paise')!~'^[0-9]+$' or (p->>'price_paise')::numeric>100000000 or jsonb_typeof(p->'negotiable') is distinct from 'boolean' then raise exception 'Invalid price';end if;
 if p->>'trade' not in ('sell','giveaway') or p->>'trade'='sell' and (p->>'price_paise')::integer<1 or p->>'trade'='giveaway' and ((p->>'price_paise')::integer<>0 or (p->>'negotiable')::boolean) then raise exception 'Invalid trade';end if;
 foreach k in array optional_keys loop
  if p?k and jsonb_typeof(p->k) is distinct from 'string' then raise exception 'Invalid tablet field type';end if;
 end loop;
 if not(p?'other_brand') and p?|array['storage_other','ram_other','connectivity_other'] then raise exception 'Invalid tablet contract';end if;

 select * into m from public.tablet_models_v1 where id=(p->>'model_id')::uuid and brand_id=(p->>'brand_id')::uuid;
 select b.name into brand_name from public.tablet_brands_v1 b where b.id=m.brand_id;
 if m.id is null or (brand_name='Other' and not m.other)
  or (m.other and length(btrim(p->>'other_model',whitespace)) not between 2 and 100)
  or (not m.other and btrim(p->>'other_model',whitespace)<>'')
 then raise exception 'Invalid tablet catalogue selection';end if;
 if p?'other_brand' and (case when brand_name='Other'
   then length(btrim(p->>'other_brand',whitespace)) not between 2 and 100
   else btrim(p->>'other_brand',whitespace)<>'' end)
 then raise exception 'Invalid Other Brand name';end if;

 -- Seller declarations are independent of the reference model.
 if p->>'storage' not in ('16 GB','32 GB','64 GB','128 GB','256 GB','512 GB','1 TB','2 TB','Not sure')
  or p->>'connectivity' not in ('wifi','lte','five_g','unknown')
  or (p?'storage_other' and (p->>'storage'<>'Not sure' or btrim(p->>'storage_other',whitespace) !~ '^([1-9][0-9]{0,3} GB|[1-9][0-9]? TB)$'))
  or (p?'ram_other' and (p->>'ram'<>'' or btrim(p->>'ram_other',whitespace) !~ '^[1-9][0-9]{0,2} GB$'))
  or (p?'connectivity_other' and (p->>'connectivity'<>'unknown' or length(btrim(p->>'connectivity_other',whitespace)) not between 2 and 60))
 then raise exception 'Invalid tablet specification';end if;
 if p->>'ram' !~ '^(2|3|4|6|8|12|16) GB$|^$' or length(p->>'colour')>40 or p->>'hardware_model_number'!~'^[A-Za-z][A-Za-z0-9-]{1,19}$|^$' then raise exception 'Invalid tablet specification';end if;
 if p->>'condition' not in ('new','like_new','good','fair') or p->>'powers_on' not in ('yes','untested') or p->>'screen_touch_status' not in ('working','marked','fault','unknown') or p->>'battery_charging_status' not in ('normal','reduced','charging_fault','untested') or p->>'transfer_lock_status'<>'clear' or p->>'repair_history' not in ('none','screen','battery','other','unknown') then raise exception 'Invalid condition or unresolved transfer lock';end if;
 if (p->>'screen_touch_status'<>'working' or p->>'battery_charging_status'<>'normal' or p->>'repair_history'='other') and length(trim(p->>'other_defects'))<3 then raise exception 'Describe faults and uncertainty';end if;
 if length(p->>'other_defects')>1000 or length(p->>'stylus_description')>100 or length(p->>'keyboard_description')>100 or length(trim(p->>'title')) not between 3 and 150 or length(trim(p->>'description')) not between 10 and 5000 then raise exception 'Invalid tablet text length';end if;
 if jsonb_typeof(p->'included') is distinct from 'array' or jsonb_array_length(p->'included')>8 then raise exception 'Invalid accessories';end if;
 if exists(select 1 from jsonb_array_elements(p->'included') x where jsonb_typeof(x)<>'string') or exists(select 1 from jsonb_array_elements_text(p->'included') x where x not in ('Original box','Bill/invoice','Charger','Charging cable','Stylus/pen','Keyboard','Protective cover/case','Under warranty')) or (select count(distinct x) from jsonb_array_elements_text(p->'included') x)<>jsonb_array_length(p->'included') then raise exception 'Invalid accessories';end if;
 if not(p->'included' ? 'Stylus/pen') and p->>'stylus_description'<>'' or not(p->'included' ? 'Keyboard') and p->>'keyboard_description'<>'' then raise exception 'Accessory detail without accessory';end if;
 v:=p->>'warranty_until';
 if p->'included' ? 'Under warranty' then
  if v!~'^[0-9]{4}-(0[1-9]|1[0-2])$' or v<to_char(current_date,'YYYY-MM') or left(v,4)::integer>extract(year from current_date)+10 then raise exception 'Invalid warranty';end if;
 elsif v<>'' then raise exception 'Warranty not included';end if;
 if jsonb_typeof(p->'media_ids') is distinct from 'array' or jsonb_array_length(p->'media_ids') not between 1 and 8 or exists(select 1 from jsonb_array_elements(p->'media_ids') x where jsonb_typeof(x)<>'string') then raise exception 'Invalid media';end if;
 -- Check typed identity and connectivity individually as well as in the full text.
 foreach k in array array['other_brand','other_model','connectivity_other'] loop
  if p?k then
   if (p->>k) ~ '[[:cntrl:]]' then raise exception 'Invalid tablet text';end if;
   perform app_security.tablet_content_guard_v1(p->>k);
  end if;
 end loop;
 perform app_security.tablet_content_guard_v1(concat_ws(' ',p->>'other_brand',p->>'connectivity_other',p->>'other_model',p->>'colour',p->>'hardware_model_number',p->>'other_defects',p->>'stylus_description',p->>'keyboard_description',p->>'title',p->>'description'));
end $$;
create or replace function app_security.impl_submit_tablet_v1(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=app_security.posting_v2_actor();s public.posting_upload_sessions;r public.tablet_release_v1;photo public.posting_staged_media;ids uuid[];photo_id uuid;base text;result jsonb;city uuid;locality uuid;pin text;
 whitespace constant text:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
 custom_specs jsonb:='{}';key text;
begin
 perform app_security.validate_tablet_v1(p_payload);
 select * into s from public.posting_upload_sessions where id=(p_payload->>'session_id')::uuid and owner_id=u for update;
 if s.id is null then raise exception using errcode='42501',message='Upload session unavailable';end if;
 if not exists(select 1 from public.tablet_session_bindings_v1 b where b.session_id=s.id and b.category_id=(select category_id from public.tablet_release_v1)) then raise exception 'Cross-category session';end if;
 if s.state='submitted' then
  if not exists(select 1 from public.listing_tablet_contexts where listing_id=s.listing_id) then raise exception 'Cross-category session';end if;
  return jsonb_build_object('success',true,'listing_id',s.listing_id);
 end if;
 if s.state<>'finalizing' or s.expires_at<=now() then raise exception 'Upload session unavailable';end if;
 select r1.* into r from public.tablet_release_v1 r1 join public.categories c on c.id=r1.category_id where r1.enabled and c.is_active for share of r1,c;
 if r.category_id is null then raise exception 'Tablet category unavailable';end if;
 city:=(p_payload->>'city_id')::uuid;locality:=(p_payload->>'locality_id')::uuid;pin:=p_payload->>'pin_code';
 if pin!~'^[1-9][0-9]{5}$' or not exists(select 1 from public.postal_pincode_localities p join public.localities l on l.id=p.locality_id join public.cities c on c.id=l.city_id where p.pincode=pin and l.id=locality and l.city_id=city and l.is_active and c.is_active) then raise exception 'Invalid PIN/locality';end if;
 if jsonb_typeof(p_payload->'media_ids') is distinct from 'array' then raise exception 'Invalid photos';end if;
 select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_payload->'media_ids');
 if coalesce(cardinality(ids),0) not between 1 and 8 or (select count(distinct x) from unnest(ids) x)<>cardinality(ids) or (select count(*) from public.posting_staged_media where session_id=s.id and state='ready' and id=any(ids))<>cardinality(ids) then raise exception 'Choose 1 to 8 ready photos';end if;
 insert into public.listings(id,seller_id,category_id,city_id,locality_id,pin_code,title,description,condition,price_type,price_paise,category_attributes)
 values(s.listing_id,u,r.category_id,city,locality,pin,trim(p_payload->>'title'),trim(p_payload->>'description'),(p_payload->>'condition')::public.listing_condition_enum,(case when p_payload->>'trade'='giveaway' then 'free' when (p_payload->>'negotiable')::boolean then 'negotiable' else 'fixed' end)::public.listing_price_type_enum,(p_payload->>'price_paise')::integer,'{}');
 foreach key in array array['storage_other','ram_other','connectivity_other'] loop
  if p_payload?key then custom_specs:=custom_specs||jsonb_build_object(key,btrim(p_payload->>key,whitespace));end if;
 end loop;
 insert into public.listing_tablet_contexts(listing_id,category_id,brand_id,model_id,brand_name,model_name,details,review_required)
 select s.listing_id,r.category_id,m.brand_id,m.id,
 case when b.name='Other' then coalesce(btrim(p_payload->>'other_brand',whitespace),b.name) else b.name end,
 case when m.other then btrim(p_payload->>'other_model',whitespace) else m.name end,
 (p_payload-array['selection','session_id','brand_id','model_id','other_model','other_brand','storage_other','ram_other','connectivity_other','title','description','trade','price_paise','negotiable','pin_code','city_id','locality_id','media_ids','plan_id'])
 || custom_specs || jsonb_build_object('family',m.family,'generation',m.generation,'screen_inches',m.screen_inches),
 m.other or custom_specs<>'{}' or p_payload->>'storage'='Not sure' or p_payload->>'connectivity'='unknown' or p_payload->>'screen_touch_status'<>'working' or p_payload->>'battery_charging_status'<>'normal' or p_payload->>'powers_on'<>'yes'
 from public.tablet_models_v1 m join public.tablet_brands_v1 b on b.id=m.brand_id where m.id=(p_payload->>'model_id')::uuid;
 foreach photo_id in array ids loop
  select * into photo from public.posting_staged_media where posting_staged_media.id=photo_id and session_id=s.id and state='ready' for update;
  base:=s.listing_id::text||'/'||photo.id::text||'/';
  if (select count(*) from storage.objects where (bucket_id='listing-originals' and name=base||'original.webp') or (bucket_id='listing-derivatives' and name in (base||'thumb.webp',base||'medium.webp',base||'large.webp')))<>4 then raise exception 'Photo preparation incomplete';end if;
  insert into public.listing_media(id,listing_id,uploader_id,original_filename,content_type,file_size_bytes) values(photo.id,s.listing_id,u,'photo.webp','image/webp',photo.file_size);
  update public.listing_media set original_storage_path=base||'original.webp',thumbnail_storage_path=base||'thumb.webp',medium_storage_path=base||'medium.webp',large_storage_path=base||'large.webp',width=photo.width,height=photo.height,processing_status='ready',display_order=array_position(ids,photo.id)-1 where listing_media.id=photo.id;
 end loop;
 result:=public.seller_submit_listing(s.listing_id);if result->>'success' is distinct from 'true' then raise exception 'Submission was not acknowledged';end if;
 update public.posting_upload_sessions set state='submitted',submitted_at=now() where posting_upload_sessions.id=s.id;
 perform app_security.log_audit_event('listing.tablet_submitted','listings',s.listing_id,jsonb_build_object('contract_version',1));
 return jsonb_build_object('success',true,'listing_id',s.listing_id);
end $$;
commit;
