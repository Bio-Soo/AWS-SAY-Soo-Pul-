# -*- coding: utf-8 -*-
"""Cognito 의사 계정 시드 — say2-2team-rare-link-pool

사용법:  python cognito_seed.py
필요:    boto3, ap-northeast-2 자격증명. 자세한 내용은 COGNITO_AUTH_KO.md 참고.
"""
import boto3, sys

POOL_ID = 'ap-northeast-2_CMtZTRCTa'   # say2-2team-rare-link-pool
PASSWORD = 'DemoPass123!'
c = boto3.client('cognito-idp', region_name='ap-northeast-2')

# 병원 3개 · 의사 5명 (성균관대 2 / 삼성서울 1 / 서울아산 2)
DOCTORS = [
    dict(uid='jeong.ms', name='정민수', email='jeong.ms@skku.test',
         institution='성균관대학교병원', department='호흡기내과',
         role='호흡기내과 과장', license_no='MD-2010-1001', emr_vendor='smart_sandbox'),
    dict(uid='park.jh', name='박지훈', email='park.jh@skku.test',
         institution='성균관대학교병원', department='호흡기내과',
         role='호흡기내과 전임의', license_no='MD-2019-4471', emr_vendor='smart_sandbox'),
    dict(uid='kim.mj', name='김민준', email='kim.mj@samsung.test',
         institution='삼성서울병원', department='호흡기내과',
         role='호흡기내과 전임의', license_no='MD-2018-5547', emr_vendor='epic'),
    dict(uid='lee.sj', name='이수진', email='lee.sj@asanmc.test',
         institution='서울아산병원', department='호흡기내과',
         role='호흡기내과 전임의', license_no='MD-2015-3321', emr_vendor='cerner'),
    dict(uid='choi.ya', name='최영아', email='choi.ya@asanmc.test',
         institution='서울아산병원', department='호흡기내과',
         role='호흡기내과 임상강사', license_no='MD-2020-7788', emr_vendor='cerner'),
]

for d in DOCTORS:
    attrs = [
        {'Name': 'name',                 'Value': d['name']},
        {'Name': 'email',                'Value': d['email']},
        {'Name': 'email_verified',       'Value': 'true'},
        {'Name': 'custom:institution',   'Value': d['institution']},
        {'Name': 'custom:department',    'Value': d['department']},
        {'Name': 'custom:role',          'Value': d['role']},
        {'Name': 'custom:license_no',    'Value': d['license_no']},
        {'Name': 'custom:emr_vendor',    'Value': d['emr_vendor']},
    ]
    try:
        c.admin_create_user(
            UserPoolId=POOL_ID, Username=d['uid'],
            UserAttributes=attrs, MessageAction='SUPPRESS',
        )
        c.admin_set_user_password(
            UserPoolId=POOL_ID, Username=d['uid'],
            Password=PASSWORD, Permanent=True,
        )
        print(f"  OK  {d['uid']:10s} {d['name']}  {d['institution']}  {d['role']}")
    except c.exceptions.UsernameExistsException:
        print(f"  SKIP {d['uid']} (already exists)")
    except Exception as e:
        print(f"  FAIL {d['uid']}: {e}")
        sys.exit(1)

print(f"\n총 {len(DOCTORS)}명 · 비밀번호 모두 '{PASSWORD}'")
