.PHONY: help deploy-q2 deploy-q2-sjekk

# Bare en REF fra kommandolinjen teller. make leser også miljøvariabler som
# make-variabler, og en eksportert REF fra annet arbeid skal ikke bli deploy-ref.
MUNINN_REF_ARG := $(if $(filter command line,$(origin REF)),$(REF))

help:
	@echo "make deploy-q2 [REF=<tag|sha>]        deployer muninn til q2; standard er tuppen av muninn main"
	@echo "make deploy-q2-sjekk [REF=<tag|sha>]  bare forhåndssjekkene, starter ingen workflow"

deploy-q2:
	@scripts/deploy-q2.sh $(MUNINN_REF_ARG)

deploy-q2-sjekk:
	@DRY_RUN=1 scripts/deploy-q2.sh $(MUNINN_REF_ARG)
