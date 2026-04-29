#!/bin/bash
set -e

# ─────────────────────────────────────────────
# Developer ID Application 인증서 최초 세팅
#
# 이 스크립트는 처음 한 번만 실행합니다.
# Account Holder가 아닌 개발자 계정에서 실행하세요.
# ─────────────────────────────────────────────

CERT_DIR="$HOME/.developer_id"
CSR_PATH="$HOME/Desktop/CertificateSigningRequest.certSigningRequest"
KEY_PATH="$CERT_DIR/developer_id_key.pem"

echo "▶ Developer ID Application 인증서 세팅"
echo ""

# ── 1. 개인키 + CSR 생성 ──────────────────────
echo "🔑 개인키 및 CSR 생성..."
mkdir -p "$CERT_DIR"
openssl genrsa -out "$KEY_PATH" 2048 2>/dev/null
chmod 600 "$KEY_PATH"
openssl req -new -key "$KEY_PATH" \
    -out "$CSR_PATH" \
    -subj "/emailAddress=jmlee@tnear.com/CN=Jeongmin Lee/C=KR" 2>/dev/null

echo "✓ CSR 생성 완료: $CSR_PATH"
echo "✓ 개인키 저장: $KEY_PATH (권한 600)"
echo ""

# ── 2. Account Holder에게 요청 ───────────────
echo "─────────────────────────────────────────"
echo "📋 Account Holder에게 아래 내용 전달:"
echo ""
echo "  1. 바탕화면의 CertificateSigningRequest.certSigningRequest 파일 전달"
echo "  2. https://developer.apple.com/account/resources/certificates/add 접속"
echo "  3. Developer ID Application 선택 → Continue"
echo "  4. G2 Sub-CA 선택 → Continue"
echo "  5. CSR 파일 업로드 → Continue"
echo "  6. 발급된 .cer 파일을 개발자에게 전달"
echo "─────────────────────────────────────────"
echo ""
echo ".cer 파일을 받은 후 아래 명령어 실행:"
echo "  ./scripts/setup_cert.sh install <경로/developerID_application.cer>"
echo ""

# ── install 서브커맨드 ────────────────────────
if [ "${1}" == "install" ] && [ -n "${2}" ]; then
    CER_PATH="${2}"
    echo "📥 인증서 설치 중..."
    security import "$CER_PATH" -k ~/Library/Keychains/login.keychain-db
    security import "$KEY_PATH" -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign

    echo ""
    echo "✓ 설치 완료. 확인:"
    security find-identity -v -p codesigning | grep "Developer ID Application" || echo "❌ 인증서를 찾을 수 없습니다."
fi
