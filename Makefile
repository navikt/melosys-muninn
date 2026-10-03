.PHONY: help deploy-q2 deploy-q2-sjekk

help:
	@echo "make deploy-q2 [REF=<tag|sha>]        deployer muninn til q2; standard er tuppen av muninn main"
	@echo "make deploy-q2-sjekk [REF=<tag|sha>]  bare forhåndssjekkene, starter ingen workflow"

deploy-q2:
	@scripts/deploy-q2.sh $(REF)

deploy-q2-sjekk:
	@DRY_RUN=1 scripts/deploy-q2.sh $(REF)
