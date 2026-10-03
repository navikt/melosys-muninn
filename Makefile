.PHONY: help deploy-q2 deploy-q2-sjekk ref-fra-kommandolinjen

# Hvor REF kan komme fra, og hva som skjer:
#   ikke satt, eller tom i miljøet   tuppen av muninn main
#   satt i miljøet                   deploy-målene avviser; `help` virker fortsatt
#   kommandolinjen                   brukes. En REF i MAKEFLAGS teller også som
#                                    kommandolinje, og make kan ikke skille dem.
# Verdien går til skriptet gjennom miljøet, uekspandert og uten skall-sitering.
MUNINN_DEPLOY_REF := $(value REF)
export MUNINN_DEPLOY_REF
REF_FRA_MILJOET := $(if $(filter environment%,$(origin REF)),$(if $(value REF),ja))

help:
	@echo "make deploy-q2 [REF=<tag|sha>]        deployer muninn til q2; standard er tuppen av muninn main"
	@echo "make deploy-q2-sjekk [REF=<tag|sha>]  bare forhåndssjekkene, starter ingen workflow"

ref-fra-kommandolinjen:
	@if [ -n "$(REF_FRA_MILJOET)" ]; then \
	  echo "REF er satt i miljøet. Oppgi den på kommandolinjen (make deploy-q2 REF=…), eller kjør 'unset REF' for tuppen av muninn main" >&2; \
	  exit 1; \
	fi

deploy-q2: ref-fra-kommandolinjen
	@scripts/deploy-q2.sh

deploy-q2-sjekk: ref-fra-kommandolinjen
	@DRY_RUN=1 scripts/deploy-q2.sh
